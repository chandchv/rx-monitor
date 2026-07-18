/**
 * Diff Detector Module
 * Compares page content across checks and alerts when unexpected changes are detected.
 * Uses character-level comparison of response body against stored baseline.
 * Supports exclusion patterns (regex) for dynamic content like timestamps or session tokens.
 *
 * Exports:
 * - computeDiffPercentage(baseline, current): Character-level diff as percentage of baseline length
 * - computeContentHash(content): SHA-256 hash of content
 * - shouldAlert(diffPercentage, threshold): Whether the diff exceeds the threshold
 * - applyExclusions(content, exclusions): Strip dynamic content before comparison
 *
 * Requirements: 22.1, 22.2, 22.3, 22.4, 22.5, 22.6, 22.7
 */

import { createHash } from 'node:crypto';

/**
 * Default diff threshold percentage. Alert when content differs by more than this
 * percentage of the baseline length.
 */
const DEFAULT_THRESHOLD = 5;

/**
 * Computes the diff percentage between a baseline string and a current string
 * using character-level comparison.
 *
 * The formula is: changed characters / baseline length × 100
 *
 * Changed characters are computed as the number of character positions where
 * the current content differs from the baseline, plus any length difference.
 *
 * @param {string} baseline - The stored baseline content
 * @param {string} current - The current response body content
 * @returns {number} The diff percentage (0 to 100+). Returns 0 if both are empty.
 *   Returns 100 if baseline is empty but current is not.
 */
export function computeDiffPercentage(baseline, current) {
  // Handle edge cases
  if (baseline === current) {
    return 0;
  }

  if (!baseline && !current) {
    return 0;
  }

  // If baseline is empty but current has content, that's 100% change
  if (!baseline || baseline.length === 0) {
    return current && current.length > 0 ? 100 : 0;
  }

  // Count character-level differences
  const baselineLen = baseline.length;
  const currentLen = current.length;
  const minLen = Math.min(baselineLen, currentLen);

  let changedChars = 0;

  // Count mismatches in the overlapping portion
  for (let i = 0; i < minLen; i++) {
    if (baseline[i] !== current[i]) {
      changedChars++;
    }
  }

  // Characters added or removed beyond the overlapping portion count as changes
  changedChars += Math.abs(baselineLen - currentLen);

  // Formula: changed chars / baseline length × 100
  return (changedChars / baselineLen) * 100;
}

/**
 * Computes the SHA-256 hash of the given content string.
 *
 * @param {string} content - The content to hash
 * @returns {string} The hex-encoded SHA-256 hash
 */
export function computeContentHash(content) {
  if (content === null || content === undefined) {
    content = '';
  }
  return createHash('sha256').update(String(content), 'utf8').digest('hex');
}

/**
 * Determines whether a content change alert should be triggered based on the
 * diff percentage and the configured threshold.
 *
 * @param {number} diffPercentage - The computed diff percentage
 * @param {number} [threshold] - The alerting threshold (default: 5%)
 * @returns {boolean} True if the diff percentage exceeds the threshold
 */
export function shouldAlert(diffPercentage, threshold) {
  const effectiveThreshold = typeof threshold === 'number' && !isNaN(threshold)
    ? threshold
    : DEFAULT_THRESHOLD;

  return diffPercentage > effectiveThreshold;
}

/**
 * Applies exclusion patterns to content by replacing matched segments with empty strings.
 * This removes dynamic content (e.g., timestamps, session tokens, nonces) before comparison.
 *
 * Each exclusion is a regex pattern string. Invalid regex patterns are silently skipped.
 *
 * @param {string} content - The content to process
 * @param {Array<string>} exclusions - Array of regex pattern strings to strip from content
 * @returns {string} The content with excluded patterns removed
 */
export function applyExclusions(content, exclusions) {
  if (!content) {
    return '';
  }

  if (!exclusions || !Array.isArray(exclusions) || exclusions.length === 0) {
    return content;
  }

  let result = content;

  for (const pattern of exclusions) {
    if (!pattern || typeof pattern !== 'string') {
      continue;
    }

    try {
      const regex = new RegExp(pattern, 'g');
      result = result.replace(regex, '');
    } catch (e) {
      // Skip invalid regex patterns silently
      continue;
    }
  }

  return result;
}

/**
 * Generates a summary of changed lines between baseline and current content.
 * Returns an array of objects describing which lines changed and by how many characters.
 *
 * @param {string} baseline - The baseline content
 * @param {string} current - The current content
 * @returns {Array<{line: number, chars: number}>} Summary of changed lines
 */
export function getChangedLineSummary(baseline, current) {
  if (!baseline && !current) {
    return [];
  }

  const baselineLines = (baseline || '').split('\n');
  const currentLines = (current || '').split('\n');
  const maxLines = Math.max(baselineLines.length, currentLines.length);
  const changes = [];

  for (let i = 0; i < maxLines; i++) {
    const baseLine = baselineLines[i] || '';
    const currLine = currentLines[i] || '';

    if (baseLine !== currLine) {
      // Count character differences on this line
      const lineMinLen = Math.min(baseLine.length, currLine.length);
      let lineChangedChars = Math.abs(baseLine.length - currLine.length);
      for (let j = 0; j < lineMinLen; j++) {
        if (baseLine[j] !== currLine[j]) {
          lineChangedChars++;
        }
      }
      changes.push({ line: i + 1, chars: lineChangedChars });
    }
  }

  return changes;
}
