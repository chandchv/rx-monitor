/**
 * DNS Resolver Module
 * Measures DNS resolution time separately from HTTP response time.
 * Supports failure classification (NXDOMAIN, timeout, SERVFAIL) and IP address detection.
 */

import dns from 'node:dns';
import { performance } from 'node:perf_hooks';
import net from 'node:net';

const DNS_TIMEOUT_MS = 5000;

/**
 * Resolves a hostname to an IP address and measures the resolution time.
 * @param {string} hostname - The hostname to resolve
 * @returns {Promise<{ ip: string, timeMs: number }>}
 * @throws {Error} With type property: 'NXDOMAIN', 'timeout', or 'SERVFAIL'
 */
export async function resolveWithTiming(hostname) {
  const start = performance.now();

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      const elapsed = Math.round(performance.now() - start);
      const error = new Error(`DNS resolution timed out after ${DNS_TIMEOUT_MS}ms`);
      error.type = 'timeout';
      error.timeMs = elapsed;
      reject(error);
    }, DNS_TIMEOUT_MS);

    dns.lookup(hostname, (err, address) => {
      clearTimeout(timeoutId);
      const elapsed = Math.round(performance.now() - start);

      if (err) {
        const error = new Error(`DNS resolution failed for ${hostname}: ${err.message}`);
        error.type = classifyDnsError(err);
        error.timeMs = elapsed;
        reject(error);
        return;
      }

      resolve({ ip: address, timeMs: elapsed });
    });
  });
}

/**
 * Detects whether a URL string or hostname is an IP address (IPv4 or IPv6).
 * If given a full URL, extracts the hostname first.
 * @param {string} urlString - A URL or hostname string
 * @returns {boolean} True if the host is an IP address
 */
export function isIPAddress(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    return false;
  }

  let host = urlString;

  // Try to extract hostname from a URL
  try {
    if (urlString.includes('://')) {
      const parsed = new URL(urlString);
      host = parsed.hostname;
    }
  } catch {
    // If URL parsing fails, treat the whole string as a potential host
  }

  // Remove brackets from IPv6 (e.g., "[::1]" -> "::1")
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }

  return net.isIP(host) !== 0;
}

/**
 * Computes DNS resolution time statistics from an array of DNS times.
 * @param {number[]} dnsTimesArray - Array of DNS resolution times in milliseconds
 * @returns {{ avg: number, min: number, max: number }}
 */
export function computeDnsStats(dnsTimesArray) {
  if (!Array.isArray(dnsTimesArray) || dnsTimesArray.length === 0) {
    return { avg: 0, min: 0, max: 0 };
  }

  const sum = dnsTimesArray.reduce((acc, t) => acc + t, 0);
  const avg = Math.round(sum / dnsTimesArray.length);
  const min = Math.min(...dnsTimesArray);
  const max = Math.max(...dnsTimesArray);

  return { avg, min, max };
}

/**
 * Classifies a DNS error into a known failure reason.
 * @param {Error} err - The error from dns.lookup
 * @returns {'NXDOMAIN'|'timeout'|'SERVFAIL'} The classified error type
 */
function classifyDnsError(err) {
  const code = err.code || '';

  if (code === 'ENOTFOUND') {
    return 'NXDOMAIN';
  }
  if (code === 'ETIMEOUT' || code === 'EAI_AGAIN') {
    return 'timeout';
  }
  if (code === 'ESERVFAIL' || code === 'SERVFAIL') {
    return 'SERVFAIL';
  }

  // Default to NXDOMAIN for unclassified DNS errors
  return 'NXDOMAIN';
}
