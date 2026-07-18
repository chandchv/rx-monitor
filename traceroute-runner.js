/**
 * Traceroute Runner Module
 * Automatically executes network traceroute diagnostics when a check failure is detected.
 * Supports both Windows (tracert) and Linux/Mac (traceroute) commands.
 * Implements rate limiting and graceful degradation.
 */

import { spawn } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Tracks last traceroute execution time per monitor for rate limiting.
 * Key: monitorId, Value: timestamp (ms) of last run
 */
const lastRunTimes = new Map();

/**
 * Determines if a traceroute can be run for a given monitor based on rate limiting.
 * Enforces at most 1 traceroute per monitor per cooldown window.
 *
 * @param {number|string} monitorId - The monitor identifier
 * @param {number|null} lastRunTime - The timestamp (ms) of the last traceroute run for this monitor (null if never run)
 * @param {number} [cooldownMinutes=5] - Minimum minutes between traceroutes for the same monitor
 * @returns {boolean} True if a traceroute is allowed
 */
export function canRunTraceroute(monitorId, lastRunTime, cooldownMinutes = 5) {
  if (lastRunTime === null || lastRunTime === undefined) {
    return true;
  }

  const cooldownMs = cooldownMinutes * 60 * 1000;
  const now = Date.now();
  return (now - lastRunTime) >= cooldownMs;
}

/**
 * Executes a traceroute to the given hostname and parses the results.
 * Uses `tracert` on Windows and `traceroute` on Linux/Mac.
 * Aborts after timeoutSec seconds, storing partial results marked incomplete.
 * Gracefully degrades if the traceroute command is unavailable.
 *
 * @param {string} hostname - The target hostname or IP to trace
 * @param {number} [maxHops=30] - Maximum number of hops
 * @param {number} [timeoutSec=30] - Maximum execution time in seconds before abort
 * @returns {Promise<TracerouteResult>}
 *
 * @typedef {Object} TracerouteResult
 * @property {Array<{seq: number, ip: string, hostname: string, rtt_ms: number|null}>} hops
 * @property {boolean} complete - Whether the traceroute finished without being aborted
 * @property {boolean} target_reached - Whether the final hop reached the target
 */
export async function runTraceroute(hostname, maxHops = 30, timeoutSec = 30) {
  const isWindows = platform() === 'win32';
  const command = isWindows ? 'tracert' : 'traceroute';
  const args = buildArgs(hostname, maxHops, isWindows);

  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let aborted = false;
    let timedOut = false;

    try {
      child = spawn(command, args, { windowsHide: true });
    } catch (err) {
      // Command unavailable — graceful degradation
      resolve({
        hops: [],
        complete: false,
        target_reached: false,
        error: `Traceroute command unavailable: ${err.message}`
      });
      return;
    }

    const timeoutMs = timeoutSec * 1000;
    const timer = setTimeout(() => {
      timedOut = true;
      aborted = true;
      child.kill('SIGTERM');
    }, timeoutMs);

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      // Command not found or execution error — graceful degradation
      resolve({
        hops: [],
        complete: false,
        target_reached: false,
        error: `Traceroute command failed: ${err.message}`
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);

      const hops = parseTracerouteOutput(stdout, isWindows);
      const targetReached = checkTargetReached(hops, hostname, stdout, isWindows);

      resolve({
        hops,
        complete: !aborted,
        target_reached: targetReached
      });
    });
  });
}

/**
 * Builds command-line arguments for the traceroute command.
 * @param {string} hostname - Target hostname
 * @param {number} maxHops - Maximum hop count
 * @param {boolean} isWindows - Whether running on Windows
 * @returns {string[]}
 */
function buildArgs(hostname, maxHops, isWindows) {
  if (isWindows) {
    // tracert -h <maxHops> -d <hostname>
    // -d disables hostname resolution for speed (we parse IPs directly)
    return ['-h', String(maxHops), hostname];
  } else {
    // traceroute -m <maxHops> <hostname>
    return ['-m', String(maxHops), hostname];
  }
}

/**
 * Parses traceroute/tracert output into structured hop data.
 * @param {string} output - Raw stdout from traceroute command
 * @param {boolean} isWindows - Whether output is from Windows tracert
 * @returns {Array<{seq: number, ip: string, hostname: string, rtt_ms: number|null}>}
 */
function parseTracerouteOutput(output, isWindows) {
  if (!output || typeof output !== 'string') {
    return [];
  }

  const lines = output.split('\n');
  const hops = [];

  if (isWindows) {
    return parseWindowsOutput(lines);
  } else {
    return parseUnixOutput(lines);
  }
}

/**
 * Parses Windows tracert output.
 * Example lines:
 *   1     1 ms     1 ms     1 ms  192.168.1.1
 *   2     *        *        *     Request timed out.
 *   3    10 ms    11 ms    10 ms  hostname [10.0.0.1]
 */
function parseWindowsOutput(lines) {
  const hops = [];
  // Windows tracert hop line pattern:
  // seq  rtt1  rtt2  rtt3  hostname [ip] or ip
  const hopRegex = /^\s*(\d+)\s+(.+)$/;

  for (const line of lines) {
    const match = line.match(hopRegex);
    if (!match) continue;

    const seq = parseInt(match[1], 10);
    if (isNaN(seq) || seq < 1) continue;

    const rest = match[2].trim();

    // Check for "Request timed out." or all asterisks
    if (rest.includes('Request timed out') || /^\*\s+\*\s+\*/.test(rest)) {
      hops.push({
        seq,
        ip: '*',
        hostname: 'unknown',
        rtt_ms: null
      });
      continue;
    }

    // Parse RTT values and hostname/IP
    const rtt = extractRttWindows(rest);
    const { ip, hostname } = extractHostWindows(rest);

    hops.push({
      seq,
      ip: ip || '*',
      hostname: hostname || 'unknown',
      rtt_ms: rtt
    });
  }

  return hops;
}

/**
 * Extracts RTT (first valid value) from Windows tracert line remainder.
 * @param {string} rest - The portion after sequence number
 * @returns {number|null}
 */
function extractRttWindows(rest) {
  // Match patterns like "1 ms", "<1 ms", "10 ms"
  const rttMatch = rest.match(/(<?\d+)\s*ms/);
  if (rttMatch) {
    const val = rttMatch[1].replace('<', '');
    const num = parseInt(val, 10);
    return isNaN(num) ? null : num;
  }
  return null;
}

/**
 * Extracts IP and hostname from Windows tracert line remainder.
 * Handles formats: "hostname [ip]" or just "ip"
 * @param {string} rest
 * @returns {{ ip: string, hostname: string }}
 */
function extractHostWindows(rest) {
  // Pattern: hostname [ip]
  const bracketMatch = rest.match(/(\S+)\s+\[([^\]]+)\]\s*$/);
  if (bracketMatch) {
    return { hostname: bracketMatch[1], ip: bracketMatch[2] };
  }

  // Pattern: just an IP at the end of the line
  const ipMatch = rest.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\s*$/);
  if (ipMatch) {
    return { ip: ipMatch[1], hostname: ipMatch[1] };
  }

  // Try to grab the last word as the host
  const words = rest.trim().split(/\s+/);
  const lastWord = words[words.length - 1];
  if (lastWord && lastWord !== 'ms' && lastWord !== '*') {
    return { ip: lastWord, hostname: lastWord };
  }

  return { ip: '*', hostname: 'unknown' };
}

/**
 * Parses Unix/Mac traceroute output.
 * Example lines:
 *   1  gateway (192.168.1.1)  1.234 ms  1.456 ms  1.789 ms
 *   2  * * *
 *   3  10.0.0.1 (10.0.0.1)  10.123 ms  10.456 ms  10.789 ms
 */
function parseUnixOutput(lines) {
  const hops = [];

  for (const line of lines) {
    // Unix traceroute hop line starts with a sequence number
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match) continue;

    const seq = parseInt(match[1], 10);
    if (isNaN(seq) || seq < 1) continue;

    const rest = match[2].trim();

    // All asterisks — no response
    if (/^\*\s*\*\s*\*/.test(rest)) {
      hops.push({
        seq,
        ip: '*',
        hostname: 'unknown',
        rtt_ms: null
      });
      continue;
    }

    // Parse hostname (ip) rtt ms ...
    const { ip, hostname } = extractHostUnix(rest);
    const rtt = extractRttUnix(rest);

    hops.push({
      seq,
      ip: ip || '*',
      hostname: hostname || 'unknown',
      rtt_ms: rtt
    });
  }

  return hops;
}

/**
 * Extracts hostname and IP from Unix traceroute line.
 * Format: "hostname (ip)" or "ip (ip)" or just "ip"
 * @param {string} rest
 * @returns {{ ip: string, hostname: string }}
 */
function extractHostUnix(rest) {
  // Pattern: hostname (ip)
  const hostIpMatch = rest.match(/^(\S+)\s+\(([^)]+)\)/);
  if (hostIpMatch) {
    return { hostname: hostIpMatch[1], ip: hostIpMatch[2] };
  }

  // Pattern: just IP at the start
  const ipMatch = rest.match(/^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
  if (ipMatch) {
    return { ip: ipMatch[1], hostname: ipMatch[1] };
  }

  return { ip: '*', hostname: 'unknown' };
}

/**
 * Extracts the first RTT value from Unix traceroute line.
 * @param {string} rest
 * @returns {number|null}
 */
function extractRttUnix(rest) {
  // Match first numeric value followed by "ms"
  const rttMatch = rest.match(/(\d+\.?\d*)\s*ms/);
  if (rttMatch) {
    const num = parseFloat(rttMatch[1]);
    return isNaN(num) ? null : Math.round(num);
  }
  return null;
}

/**
 * Determines if the traceroute reached the target.
 * @param {Array} hops - Parsed hops
 * @param {string} hostname - Target hostname
 * @param {string} output - Raw output
 * @param {boolean} isWindows - Platform flag
 * @returns {boolean}
 */
function checkTargetReached(hops, hostname, output, isWindows) {
  if (hops.length === 0) return false;

  // Check if "Trace complete" appears (Windows)
  if (isWindows && output.includes('Trace complete')) {
    return true;
  }

  // Check if the last hop's IP or hostname matches the target
  const lastHop = hops[hops.length - 1];
  if (lastHop.ip === '*') return false;

  // If the output contains the hostname in the last hop, consider it reached
  if (lastHop.hostname.includes(hostname) || lastHop.ip === hostname) {
    return true;
  }

  // On Unix, if the trace ended without reaching max hops and last hop has a real IP
  if (!isWindows && lastHop.ip !== '*' && lastHop.rtt_ms !== null) {
    return true;
  }

  return false;
}
