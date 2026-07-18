/**
 * Header Validator Module
 * Validates HTTP response headers against configured rules.
 * Supports presence, exact value, and contains substring validation types.
 * Header name matching is case-insensitive.
 */

const VALID_RULE_TYPES = ['presence', 'exact', 'contains'];

const SECURITY_PRESET_HEADERS = [
  'Strict-Transport-Security',
  'Content-Security-Policy',
  'X-Frame-Options',
  'X-Content-Type-Options',
  'Referrer-Policy'
];

/**
 * Validates an array of header rules for correctness.
 * @param {Array} rules - Array of HeaderRule objects
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateHeaderRules(rules) {
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

    if (typeof rule.header !== 'string' || rule.header.length === 0) {
      errors.push(`Rule ${i}: header must be a non-empty string`);
    }

    if (!VALID_RULE_TYPES.includes(rule.type)) {
      errors.push(`Rule ${i}: invalid type "${rule.type}", must be one of: ${VALID_RULE_TYPES.join(', ')}`);
    }

    // For exact and contains types, expected must be a non-empty string
    if ((rule.type === 'exact' || rule.type === 'contains') &&
        (typeof rule.expected !== 'string' || rule.expected.length === 0)) {
      errors.push(`Rule ${i}: expected must be a non-empty string for type "${rule.type}"`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Evaluates response headers against an array of header rules.
 * Header name matching is case-insensitive.
 * @param {object} headers - Key-value map of response headers
 * @param {Array} rules - Array of HeaderRule objects
 * @returns {{ pass: boolean, failures: Array<{ header: string, type: string, expected: string, actual: string|null }> }}
 */
export function evaluateHeaders(headers, rules) {
  const failures = [];

  if (!Array.isArray(rules) || rules.length === 0) {
    return { pass: true, failures: [] };
  }

  // Normalize headers to a lowercase-key map for case-insensitive lookup
  const normalizedHeaders = normalizeHeaders(headers);

  for (const rule of rules) {
    const result = evaluateRule(normalizedHeaders, rule);
    if (!result.pass) {
      failures.push(result.failure);
    }
  }

  return { pass: failures.length === 0, failures };
}

/**
 * Returns the built-in security header preset as presence rules.
 * Includes: Strict-Transport-Security, Content-Security-Policy,
 * X-Frame-Options, X-Content-Type-Options, Referrer-Policy.
 * @returns {Array<{ header: string, type: string, expected: string|null }>}
 */
export function getSecurityPreset() {
  return SECURITY_PRESET_HEADERS.map(header => ({
    header,
    type: 'presence',
    expected: null
  }));
}

/**
 * Normalizes headers object to lowercase keys for case-insensitive matching.
 * @param {object} headers - Raw headers object
 * @returns {Map<string, string>} Map with lowercase keys to original values
 */
function normalizeHeaders(headers) {
  const map = new Map();

  if (!headers || typeof headers !== 'object') {
    return map;
  }

  for (const [key, value] of Object.entries(headers)) {
    map.set(key.toLowerCase(), value);
  }

  return map;
}

/**
 * Evaluates a single header rule against the normalized headers.
 * @param {Map<string, string>} normalizedHeaders - Map with lowercase keys
 * @param {object} rule - A HeaderRule object
 * @returns {{ pass: boolean, failure: object|null }}
 */
function evaluateRule(normalizedHeaders, rule) {
  const headerKey = rule.header.toLowerCase();
  const actualValue = normalizedHeaders.has(headerKey) ? normalizedHeaders.get(headerKey) : null;

  switch (rule.type) {
    case 'presence':
      return evaluatePresence(rule, actualValue);
    case 'exact':
      return evaluateExact(rule, actualValue);
    case 'contains':
      return evaluateContains(rule, actualValue);
    default:
      return {
        pass: false,
        failure: {
          header: rule.header,
          type: rule.type,
          expected: rule.expected || '',
          actual: actualValue
        }
      };
  }
}

/**
 * Presence check: header exists regardless of value.
 */
function evaluatePresence(rule, actualValue) {
  if (actualValue !== null) {
    return { pass: true, failure: null };
  }
  return {
    pass: false,
    failure: {
      header: rule.header,
      type: 'presence',
      expected: 'present',
      actual: null
    }
  };
}

/**
 * Exact value check: case-sensitive full value comparison.
 */
function evaluateExact(rule, actualValue) {
  if (actualValue === null) {
    return {
      pass: false,
      failure: {
        header: rule.header,
        type: 'exact',
        expected: rule.expected,
        actual: null
      }
    };
  }

  if (actualValue === rule.expected) {
    return { pass: true, failure: null };
  }

  return {
    pass: false,
    failure: {
      header: rule.header,
      type: 'exact',
      expected: rule.expected,
      actual: actualValue
    }
  };
}

/**
 * Contains check: case-sensitive substring search within header value.
 */
function evaluateContains(rule, actualValue) {
  if (actualValue === null) {
    return {
      pass: false,
      failure: {
        header: rule.header,
        type: 'contains',
        expected: rule.expected,
        actual: null
      }
    };
  }

  if (actualValue.includes(rule.expected)) {
    return { pass: true, failure: null };
  }

  return {
    pass: false,
    failure: {
      header: rule.header,
      type: 'contains',
      expected: rule.expected,
      actual: actualValue
    }
  };
}
