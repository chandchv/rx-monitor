/**
 * Percentile Calculator Module
 * Computes response time percentiles (p50, p95, p99) over configurable time windows.
 * Uses the nearest-rank method for percentile computation.
 * Only includes successful checks in calculation.
 */

const VALID_TIME_WINDOWS = ['1h', '6h', '24h', '7d', '30d'];
const MIN_DATA_POINTS = 20;

/**
 * Checks if the given time window string is valid.
 * @param {string} window - Time window string to validate
 * @returns {boolean} True if the window is one of: '1h', '6h', '24h', '7d', '30d'
 */
export function isValidTimeWindow(window) {
  return VALID_TIME_WINDOWS.includes(window);
}

/**
 * Computes a single percentile from a pre-sorted array of values using the nearest-rank method.
 * Formula: index = Math.ceil(percentile / 100 * N) - 1
 * 
 * @param {number[]} sortedValues - Array of numeric values, already sorted in ascending order
 * @param {number} percentile - Percentile to compute (0-100)
 * @returns {number|null} The percentile value, or null if fewer than 20 data points
 */
export function computePercentile(sortedValues, percentile) {
  if (!Array.isArray(sortedValues) || sortedValues.length < MIN_DATA_POINTS) {
    return null;
  }

  if (percentile < 0 || percentile > 100) {
    return null;
  }

  const N = sortedValues.length;
  const index = Math.ceil(percentile / 100 * N) - 1;

  // Clamp index to valid range
  const clampedIndex = Math.max(0, Math.min(index, N - 1));

  return sortedValues[clampedIndex];
}

/**
 * Computes p50, p95, and p99 percentiles from an unsorted array of values.
 * Filters out non-numeric values before computation.
 * 
 * @param {Array} values - Array of values (will be filtered to numbers and sorted)
 * @returns {{ p50: number|null, p95: number|null, p99: number|null }} Object with percentile values
 */
export function computeAllPercentiles(values) {
  const nullResult = { p50: null, p95: null, p99: null };

  if (!Array.isArray(values)) {
    return nullResult;
  }

  // Filter to only valid numbers (exclude NaN, Infinity, non-numbers)
  const numericValues = values.filter(
    v => typeof v === 'number' && Number.isFinite(v)
  );

  if (numericValues.length < MIN_DATA_POINTS) {
    return nullResult;
  }

  // Sort numerically in ascending order
  const sorted = [...numericValues].sort((a, b) => a - b);

  return {
    p50: computePercentile(sorted, 50),
    p95: computePercentile(sorted, 95),
    p99: computePercentile(sorted, 99),
  };
}
