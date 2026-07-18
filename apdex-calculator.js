/**
 * Apdex Calculator Module
 * Computes Application Performance Index scores based on configurable
 * satisfied/tolerating thresholds.
 * 
 * Apdex formula: (satisfied + tolerating/2) / total
 * Classification: satisfied (rt ≤ T), tolerating (T < rt ≤ 4T), frustrated (rt > 4T or failure)
 */

const DEFAULT_THRESHOLD_MS = 500;
const MIN_RESULTS = 20;

/**
 * Classifies a single response time into satisfied, tolerating, or frustrated.
 * 
 * @param {number} responseTimeMs - Response time in milliseconds
 * @param {number} [satisfiedThresholdMs=500] - Satisfied threshold T in milliseconds
 * @returns {'satisfied'|'tolerating'|'frustrated'} Classification result
 */
export function classifyResponse(responseTimeMs, satisfiedThresholdMs = DEFAULT_THRESHOLD_MS) {
  if (responseTimeMs <= satisfiedThresholdMs) {
    return 'satisfied';
  }
  if (responseTimeMs <= 4 * satisfiedThresholdMs) {
    return 'tolerating';
  }
  return 'frustrated';
}

/**
 * Computes the Apdex score from pre-classified counts.
 * Formula: (satisfiedCount + toleratingCount / 2) / totalCount, rounded to 2 decimal places.
 * Returns null if totalCount < 20.
 * 
 * @param {number} satisfiedCount - Number of satisfied responses
 * @param {number} toleratingCount - Number of tolerating responses
 * @param {number} totalCount - Total number of responses
 * @returns {number|null} Apdex score rounded to 2 decimal places, or null if < 20 results
 */
export function computeApdex(satisfiedCount, toleratingCount, totalCount) {
  if (totalCount < MIN_RESULTS) {
    return null;
  }

  const score = (satisfiedCount + toleratingCount / 2) / totalCount;
  return Math.round(score * 100) / 100;
}

/**
 * Returns the Apdex classification label for a given score.
 * 
 * @param {number|null} score - Apdex score (0.0 to 1.0)
 * @returns {'Excellent'|'Good'|'Fair'|'Poor'|'Unacceptable'|null} Classification label
 */
export function getApdexLabel(score) {
  if (score === null || score === undefined) {
    return null;
  }

  if (score >= 0.94) return 'Excellent';
  if (score >= 0.85) return 'Good';
  if (score >= 0.70) return 'Fair';
  if (score >= 0.50) return 'Poor';
  return 'Unacceptable';
}

/**
 * Computes a full Apdex result from an array of check results.
 * Failed checks (success === false) are automatically classified as frustrated.
 * 
 * @param {Array<{responseTime: number, success: boolean}>} results - Array of check results
 * @param {number} [thresholdMs=500] - Satisfied threshold in milliseconds
 * @returns {ApdexResult} Full Apdex result object
 */
export function computeApdexFromResults(results, thresholdMs = DEFAULT_THRESHOLD_MS) {
  const total = Array.isArray(results) ? results.length : 0;

  let satisfied = 0;
  let tolerating = 0;
  let frustrated = 0;

  if (Array.isArray(results)) {
    for (const result of results) {
      if (!result.success) {
        frustrated++;
      } else {
        const classification = classifyResponse(result.responseTime, thresholdMs);
        if (classification === 'satisfied') satisfied++;
        else if (classification === 'tolerating') tolerating++;
        else frustrated++;
      }
    }
  }

  const score = computeApdex(satisfied, tolerating, total);
  const label = getApdexLabel(score);

  return {
    score,
    label,
    satisfied,
    tolerating,
    frustrated,
    total,
    threshold_ms: thresholdMs,
  };
}
