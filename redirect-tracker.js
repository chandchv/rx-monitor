/**
 * Redirect Tracker Module
 * Follows HTTP redirect chains and records each hop including URL, status code,
 * and response time. Detects redirect loops and enforces per-hop timeouts.
 */

import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

/**
 * Follows a redirect chain starting from the given URL, recording each hop.
 * Does NOT use automatic redirect following — each redirect is handled manually.
 *
 * @param {string} url - The starting URL to follow
 * @param {number} [maxHops=10] - Maximum number of redirects to follow before aborting
 * @param {number} [hopTimeout=10000] - Per-hop timeout in milliseconds
 * @returns {Promise<RedirectChainResult>}
 */
export async function followRedirects(url, maxHops = 10, hopTimeout = 10000) {
  const hops = [];
  let currentUrl = url;
  let redirectCount = 0;

  while (true) {
    let hopResult;

    try {
      hopResult = await executeHop(currentUrl, hopTimeout);
    } catch (err) {
      // Timeout or network error on this hop
      return {
        hops,
        final_url: currentUrl,
        final_status: null,
        aborted: true,
        abort_reason: `Timeout after ${hopTimeout}ms on hop URL: ${currentUrl}`
      };
    }

    hops.push({
      url: currentUrl,
      status_code: hopResult.statusCode,
      response_time_ms: hopResult.responseTimeMs
    });

    // If this is not a redirect, we've reached the final destination
    if (!isRedirectStatus(hopResult.statusCode)) {
      return {
        hops,
        final_url: currentUrl,
        final_status: hopResult.statusCode,
        aborted: false,
        abort_reason: null
      };
    }

    // This hop was a redirect — increment counter
    redirectCount++;

    // If we've hit the max number of redirect hops, abort
    if (redirectCount >= maxHops) {
      return {
        hops,
        final_url: currentUrl,
        final_status: hopResult.statusCode,
        aborted: true,
        abort_reason: `Redirect loop detected: exceeded maximum of ${maxHops} hops`
      };
    }

    // Get next URL from Location header
    const location = hopResult.location;
    if (!location) {
      // Redirect status but no Location header — treat as final destination
      return {
        hops,
        final_url: currentUrl,
        final_status: hopResult.statusCode,
        aborted: false,
        abort_reason: null
      };
    }

    // Resolve relative URLs against current URL
    currentUrl = resolveUrl(currentUrl, location);
  }
}

/**
 * Executes a single HTTP request without following redirects.
 * @param {string} url - The URL to request
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<{ statusCode: number, responseTimeMs: number, location: string|null }>}
 */
function executeHop(url, timeout) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      timeout: timeout,
      headers: {
        'User-Agent': 'RxMonitor/1.0 Redirect-Tracker'
      }
    };

    const req = client.request(options, (res) => {
      const responseTimeMs = Date.now() - startTime;

      // Consume the response body to free up the socket
      res.resume();

      const location = res.headers['location'] || null;

      resolve({
        statusCode: res.statusCode,
        responseTimeMs,
        location
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`Timeout after ${timeout}ms on hop URL: ${url}`));
    });

    req.on('error', (err) => {
      const responseTimeMs = Date.now() - startTime;
      reject(new Error(`Request error on ${url}: ${err.message}`));
    });

    req.end();
  });
}

/**
 * Checks if a status code is a redirect (3xx).
 * @param {number} statusCode
 * @returns {boolean}
 */
function isRedirectStatus(statusCode) {
  return statusCode >= 300 && statusCode < 400;
}

/**
 * Resolves a potentially relative URL against a base URL.
 * @param {string} base - The current URL
 * @param {string} location - The Location header value
 * @returns {string}
 */
function resolveUrl(base, location) {
  try {
    return new URL(location, base).href;
  } catch {
    return location;
  }
}
