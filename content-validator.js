/**
 * Content Validator Module
 * Validates HTTP response bodies against configured content rules.
 * Supports substring match, JSON key existence, and regex pattern validation.
 */

const VALID_RULE_TYPES = ['substring', 'json_key', 'regex'];

/**
 * Validates an array of content rules for correctness.
 * @param {Array} rules - Array of ContentRule objects
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateContentRules(rules) {
  const errors = [];

  if (!Array.isArray(rules)) {
    return { valid: false, errors: ['Rules must be an array'] };
  }

  if (rules.length === 0) {
    return { valid: true, errors: [] };
  }

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];

    if (!rule || typeof rule !== 'object') {
      errors.push(`Rule ${i}: must be an object`);
      continue;
    }

    if (!VALID_RULE_TYPES.includes(rule.type)) {
      errors.push(`Rule ${i}: invalid type "${rule.type}", must be one of: ${VALID_RULE_TYPES.join(', ')}`);
    }

    if (typeof rule.value !== 'string' || rule.value.length === 0) {
      errors.push(`Rule ${i}: value must be a non-empty string`);
    }

    // Validate regex patterns are syntactically correct
    if (rule.type === 'regex' && typeof rule.value === 'string' && rule.value.length > 0) {
      try {
        new RegExp(rule.value);
      } catch (e) {
        errors.push(`Rule ${i}: invalid regex pattern "${rule.value}" - ${e.message}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Evaluates a response body against an array of content rules.
 * @param {string} body - The HTTP response body
 * @param {Array} rules - Array of ContentRule objects
 * @returns {{ pass: boolean, failures: Array<{ rule: object, reason: string }> }}
 */
export function evaluateContent(body, rules) {
  const failures = [];

  if (!Array.isArray(rules) || rules.length === 0) {
    return { pass: true, failures: [] };
  }

  // Handle empty body case
  if (body === null || body === undefined || body === '') {
    for (const rule of rules) {
      failures.push({ rule, reason: 'Response body is empty' });
    }
    return { pass: false, failures };
  }

  for (const rule of rules) {
    const result = evaluateRule(body, rule);
    if (!result.pass) {
      failures.push({ rule, reason: result.reason });
    }
  }

  return { pass: failures.length === 0, failures };
}

/**
 * Evaluates a single content rule against the body.
 * @param {string} body - The HTTP response body
 * @param {object} rule - A ContentRule object
 * @returns {{ pass: boolean, reason: string|null }}
 */
function evaluateRule(body, rule) {
  switch (rule.type) {
    case 'substring':
      return evaluateSubstring(body, rule.value);
    case 'json_key':
      return evaluateJsonKey(body, rule.value);
    case 'regex':
      return evaluateRegex(body, rule.value);
    default:
      return { pass: false, reason: `Unknown rule type: ${rule.type}` };
  }
}

/**
 * Case-sensitive substring match.
 */
function evaluateSubstring(body, value) {
  if (body.includes(value)) {
    return { pass: true, reason: null };
  }
  return { pass: false, reason: `Substring "${value}" not found in response body` };
}

/**
 * JSON key existence check using dot-notation for nested keys.
 */
function evaluateJsonKey(body, value) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    return { pass: false, reason: 'Response body is not valid JSON' };
  }

  const keys = value.split('.');
  let current = parsed;

  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return { pass: false, reason: `JSON key "${value}" does not exist in response` };
    }
    if (!Object.prototype.hasOwnProperty.call(current, key)) {
      return { pass: false, reason: `JSON key "${value}" does not exist in response` };
    }
    current = current[key];
  }

  return { pass: true, reason: null };
}

/**
 * Regex pattern match against the body.
 */
function evaluateRegex(body, value) {
  let regex;
  try {
    regex = new RegExp(value);
  } catch (e) {
    return { pass: false, reason: `Invalid regex pattern: ${e.message}` };
  }

  if (regex.test(body)) {
    return { pass: true, reason: null };
  }
  return { pass: false, reason: `Regex pattern "${value}" did not match response body` };
}
