/**
 * Geographic Checker Module
 * Executes HTTP checks from multiple geographic region endpoints in parallel.
 * Aggregates regional results to determine overall UP/DOWN/PARTIAL status.
 * Supports 3-20 configurable region endpoints with 30s per-region timeout.
 */

const PER_REGION_TIMEOUT_MS = 30000;
const MIN_REGIONS = 3;
const MAX_REGIONS = 20;

/**
 * Validate region configuration.
 * Each region must have a name and endpoint_url. Between 3-20 regions required.
 *
 * @param {Array<{name: string, endpoint_url: string}>} regions
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validateRegionConfig(regions) {
  const errors = [];

  if (!Array.isArray(regions)) {
    errors.push('Regions must be an array.');
    return { valid: false, errors };
  }

  if (regions.length < MIN_REGIONS) {
    errors.push(`At least ${MIN_REGIONS} regions are required, got ${regions.length}.`);
  }

  if (regions.length > MAX_REGIONS) {
    errors.push(`At most ${MAX_REGIONS} regions are allowed, got ${regions.length}.`);
  }

  for (let i = 0; i < regions.length; i++) {
    const region = regions[i];

    if (!region || typeof region !== 'object') {
      errors.push(`Region at index ${i} must be an object.`);
      continue;
    }

    if (!region.name || typeof region.name !== 'string' || region.name.trim() === '') {
      errors.push(`Region at index ${i} is missing a valid name.`);
    }

    if (!region.endpoint_url || typeof region.endpoint_url !== 'string' || region.endpoint_url.trim() === '') {
      errors.push(`Region at index ${i} is missing a valid endpoint_url.`);
    } else {
      try {
        const url = new URL(region.endpoint_url);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          errors.push(`Region at index ${i} endpoint_url must use http or https scheme.`);
        }
      } catch {
        errors.push(`Region at index ${i} has an invalid endpoint_url.`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Compute consensus status from an array of region results.
 * Pure function. Returns:
 * - 'UP' if more than 50% of regions report UP
 * - 'DOWN' if all regions report DOWN
 * - 'PARTIAL' if mixed (at least one differs) and not >50% UP
 *
 * Note: exactly 50% UP and 50% DOWN is NOT >50% UP, so it returns 'PARTIAL'
 * unless all are DOWN.
 *
 * @param {Array<{status: 'UP'|'DOWN'}>} regionResults
 * @returns {'UP'|'DOWN'|'PARTIAL'}
 */
export function computeConsensus(regionResults) {
  if (!Array.isArray(regionResults) || regionResults.length === 0) {
    return 'DOWN';
  }

  const total = regionResults.length;
  const upCount = regionResults.filter(r => r.status === 'UP').length;
  const downCount = total - upCount;

  // All DOWN
  if (downCount === total) {
    return 'DOWN';
  }

  // More than 50% UP → overall UP
  if (upCount > total / 2) {
    return 'UP';
  }

  // Mixed results but not majority UP → PARTIAL
  return 'PARTIAL';
}

/**
 * Execute a single region check with timeout.
 * HTTP GET to the endpoint, 2xx = UP, else DOWN.
 * Timeout or error = DOWN.
 *
 * @param {{name: string, endpoint_url: string}} region
 * @returns {Promise<{name: string, endpoint: string, status: 'UP'|'DOWN', response_time_ms: number}>}
 */
async function checkRegion(region) {
  const start = Date.now();
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PER_REGION_TIMEOUT_MS);

    const response = await fetch(region.endpoint_url, {
      method: 'GET',
      signal: controller.signal,
      redirect: 'follow'
    });
    clearTimeout(timeoutId);

    const responseTimeMs = Date.now() - start;
    const status = response.status >= 200 && response.status < 300 ? 'UP' : 'DOWN';

    return {
      name: region.name,
      endpoint: region.endpoint_url,
      status,
      response_time_ms: responseTimeMs
    };
  } catch {
    const responseTimeMs = Date.now() - start;
    return {
      name: region.name,
      endpoint: region.endpoint_url,
      status: 'DOWN',
      response_time_ms: responseTimeMs
    };
  }
}

/**
 * Run geographic check from all configured regions in parallel.
 * Each region is checked concurrently with a 30s timeout.
 *
 * @param {number} monitorId - The monitor ID (for reference/logging)
 * @param {Array<{name: string, endpoint_url: string}>} regions - Region configurations
 * @returns {Promise<GeoCheckResult>}
 */
export async function runGeographicCheck(monitorId, regions) {
  // Validate regions
  const validation = validateRegionConfig(regions);
  if (!validation.valid) {
    throw new Error(`Invalid region configuration: ${validation.errors.join('; ')}`);
  }

  // Execute all region checks in parallel
  const regionResults = await Promise.all(
    regions.map(region => checkRegion(region))
  );

  // Compute consensus from results
  const overall_status = computeConsensus(regionResults);

  // Identify down regions
  const down_regions = regionResults
    .filter(r => r.status === 'DOWN')
    .map(r => r.name);

  return {
    overall_status,
    regions: regionResults,
    down_regions
  };
}
