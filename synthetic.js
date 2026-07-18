import { getDb } from './database.js';

const VALID_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD'];
const MIN_STEPS = 2;
const MAX_STEPS = 20;
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * Validates a synthetic transaction configuration.
 * @param {object} config - The transaction configuration to validate
 * @returns {{ valid: boolean, errors: string[] }}
 */
export function validateTransactionConfig(config) {
  const errors = [];

  if (!config || typeof config !== 'object') {
    errors.push('Configuration must be an object');
    return { valid: false, errors };
  }

  if (!Array.isArray(config.steps)) {
    errors.push('Steps must be an array');
    return { valid: false, errors };
  }

  if (config.steps.length < MIN_STEPS) {
    errors.push(`Minimum of ${MIN_STEPS} steps required`);
  }

  if (config.steps.length > MAX_STEPS) {
    errors.push(`Maximum step limit of ${MAX_STEPS} exceeded`);
  }

  for (let i = 0; i < config.steps.length; i++) {
    const step = config.steps[i];

    if (!step || typeof step !== 'object') {
      errors.push(`Step ${i}: must be an object`);
      continue;
    }

    // Validate URL
    if (!step.url || typeof step.url !== 'string') {
      errors.push(`Step ${i}: url must be a non-empty string`);
    } else {
      try {
        const parsed = new URL(step.url);
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          errors.push(`Step ${i}: url must use http or https scheme`);
        }
      } catch {
        errors.push(`Step ${i}: url is not a well-formed URL`);
      }
    }

    // Validate method
    const method = (step.method || 'GET').toUpperCase();
    if (!VALID_METHODS.includes(method)) {
      errors.push(`Step ${i}: invalid HTTP method '${step.method}'`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Executes a synthetic transaction by loading its configuration from the database.
 * @param {number} transactionId - The ID of the transaction to execute
 * @returns {Promise<TransactionResult>}
 */
export async function executeSyntheticTransaction(transactionId) {
  const db = await getDb();
  const executedAt = new Date().toISOString();

  // Load transaction
  const transaction = await db.get(
    'SELECT * FROM synthetic_transactions WHERE id = ?',
    [transactionId]
  );

  if (!transaction) {
    throw new Error(`Transaction ${transactionId} not found`);
  }

  // Load steps ordered by step_order
  const steps = await db.all(
    'SELECT * FROM synthetic_steps WHERE transaction_id = ? ORDER BY step_order ASC',
    [transactionId]
  );

  if (steps.length < MIN_STEPS) {
    throw new Error(`Transaction ${transactionId} has fewer than ${MIN_STEPS} steps`);
  }

  const stepResults = [];
  let overallStatus = 'PASS';
  let failedStepIndex = null;
  let failureReason = null;
  const startTime = Date.now();

  // Shared context passed between steps (cookies, tokens, headers)
  const sharedContext = {
    cookies: {},
    headers: {},
    variables: {}
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const timeout = (step.timeout || 10) * 1000; // Convert seconds to ms

    const stepResult = await executeStep(step, i, timeout, sharedContext);
    stepResults.push(stepResult);

    if (!stepResult.pass) {
      overallStatus = 'FAIL';
      failedStepIndex = i;
      failureReason = stepResult.error;
      break; // Abort remaining steps on failure
    }
  }

  const totalTimeMs = Date.now() - startTime;

  // Store result in database
  const resultRow = await db.run(
    `INSERT INTO synthetic_results (transaction_id, overall_status, failed_step_index, failure_reason, total_time_ms, executed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [transactionId, overallStatus, failedStepIndex, failureReason, totalTimeMs, executedAt]
  );

  const resultId = resultRow.lastID;

  // Store step results
  for (const sr of stepResults) {
    await db.run(
      `INSERT INTO synthetic_step_results (result_id, step_index, status_code, response_time_ms, pass, error)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [resultId, sr.step_index, sr.status_code, sr.response_time_ms, sr.pass ? 1 : 0, sr.error]
    );
  }

  return {
    transaction_id: transactionId,
    overall_status: overallStatus,
    failed_step_index: failedStepIndex,
    failure_reason: failureReason,
    total_time_ms: totalTimeMs,
    step_results: stepResults,
    executed_at: executedAt
  };
}

/**
 * Retrieves past transaction results from the database.
 * @param {number} transactionId - The transaction ID to query
 * @param {number} [limit=10] - Maximum number of results to return
 * @returns {Promise<TransactionResult[]>}
 */
export async function getTransactionResults(transactionId, limit = 10) {
  const db = await getDb();

  const results = await db.all(
    `SELECT * FROM synthetic_results WHERE transaction_id = ? ORDER BY executed_at DESC LIMIT ?`,
    [transactionId, limit]
  );

  const output = [];

  for (const result of results) {
    const stepResults = await db.all(
      `SELECT step_index, status_code, response_time_ms, pass, error FROM synthetic_step_results WHERE result_id = ? ORDER BY step_index ASC`,
      [result.id]
    );

    output.push({
      transaction_id: result.transaction_id,
      overall_status: result.overall_status,
      failed_step_index: result.failed_step_index,
      failure_reason: result.failure_reason,
      total_time_ms: result.total_time_ms,
      step_results: stepResults.map(sr => ({
        step_index: sr.step_index,
        status_code: sr.status_code,
        response_time_ms: sr.response_time_ms,
        pass: sr.pass === 1,
        error: sr.error
      })),
      executed_at: result.executed_at
    });
  }

  return output;
}

/**
 * Executes a single step within a synthetic transaction.
 * @param {object} step - The step configuration from DB
 * @param {number} index - The zero-based step index
 * @param {number} timeoutMs - Timeout in milliseconds
 * @param {object} sharedContext - Shared cookies/headers/variables between steps
 * @returns {Promise<StepResult>}
 */
async function executeStep(step, index, timeoutMs, sharedContext) {
  const method = (step.method || 'GET').toUpperCase();
  const url = substituteVariables(step.url, sharedContext.variables);
  const startTime = Date.now();

  // Parse stored JSON fields
  let headers = {};
  try {
    headers = step.headers ? JSON.parse(step.headers) : {};
  } catch {
    headers = {};
  }

  let body = step.body || null;

  // Merge shared context headers (cookies, tokens, etc.)
  const requestHeaders = { ...sharedContext.headers, ...headers };

  // Add cookies from shared context
  const cookieString = Object.entries(sharedContext.cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
  if (cookieString) {
    requestHeaders['Cookie'] = cookieString;
  }

  // Substitute variables in body
  if (body) {
    body = substituteVariables(body, sharedContext.variables);
  }

  try {
    const response = await fetchWithTimeout(url, {
      method,
      headers: requestHeaders,
      body: method !== 'GET' && method !== 'HEAD' ? body : undefined,
      redirect: 'manual'
    }, timeoutMs);

    const responseTimeMs = Date.now() - startTime;
    const statusCode = response.status;

    // Extract data from response for context passing
    await extractFromResponse(response, step, sharedContext);

    // Check validation rules
    const validationResult = await validateStepResponse(response, step, statusCode);

    // Determine pass/fail: status 200-299 and validations pass
    const isSuccess = statusCode >= 200 && statusCode < 300 && validationResult.pass;

    return {
      step_index: index,
      status_code: statusCode,
      response_time_ms: responseTimeMs,
      pass: isSuccess,
      error: isSuccess ? null : (validationResult.error || `HTTP ${statusCode}`)
    };
  } catch (err) {
    const responseTimeMs = Date.now() - startTime;

    const isTimeout = err.name === 'AbortError' || err.message?.includes('timeout');
    const errorMessage = isTimeout
      ? `Step timeout after ${timeoutMs}ms`
      : `Request failed: ${err.message}`;

    return {
      step_index: index,
      status_code: 0,
      response_time_ms: responseTimeMs,
      pass: false,
      error: errorMessage
    };
  }
}

/**
 * Performs an HTTP fetch with a timeout using AbortController.
 */
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Extracts cookies, headers, and body variables from response to pass to subsequent steps.
 */
async function extractFromResponse(response, step, sharedContext) {
  // Extract cookies from Set-Cookie header
  const setCookieHeader = response.headers.get('set-cookie');
  if (setCookieHeader) {
    const cookies = parseCookies(setCookieHeader);
    Object.assign(sharedContext.cookies, cookies);
  }

  // Parse extract rules from step
  let extractRules = [];
  try {
    extractRules = step.extract_rules ? JSON.parse(step.extract_rules) : [];
  } catch {
    extractRules = [];
  }

  if (!Array.isArray(extractRules) || extractRules.length === 0) return;

  // Clone response for reading body (so it's not consumed)
  let responseBody = null;
  let responseHeaders = {};

  for (const rule of extractRules) {
    if (!rule || !rule.variable) continue;

    if (rule.source === 'header') {
      const value = response.headers.get(rule.path);
      if (value) {
        sharedContext.variables[rule.variable] = value;
        sharedContext.headers[rule.variable] = value;
      }
    } else if (rule.source === 'cookie') {
      const value = sharedContext.cookies[rule.path];
      if (value) {
        sharedContext.variables[rule.variable] = value;
      }
    } else if (rule.source === 'body') {
      if (responseBody === null) {
        try {
          responseBody = await response.clone().text();
        } catch {
          continue;
        }
      }
      const value = extractFromBody(responseBody, rule.path);
      if (value !== undefined) {
        sharedContext.variables[rule.variable] = value;
      }
    }
  }
}

/**
 * Extracts a value from a response body using dot-notation path (JSON) or direct content.
 */
function extractFromBody(body, path) {
  try {
    const parsed = JSON.parse(body);
    const keys = path.split('.');
    let current = parsed;
    for (const key of keys) {
      if (current === null || current === undefined || typeof current !== 'object') {
        return undefined;
      }
      current = current[key];
    }
    return current !== undefined ? String(current) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parses Set-Cookie header value into key-value pairs.
 */
function parseCookies(setCookieHeader) {
  const cookies = {};
  const parts = setCookieHeader.split(',');
  for (const part of parts) {
    const cookiePart = part.split(';')[0].trim();
    const eqIdx = cookiePart.indexOf('=');
    if (eqIdx > 0) {
      const name = cookiePart.substring(0, eqIdx).trim();
      const value = cookiePart.substring(eqIdx + 1).trim();
      cookies[name] = value;
    }
  }
  return cookies;
}

/**
 * Validates a step response against configured validation rules.
 */
async function validateStepResponse(response, step, statusCode) {
  let validationRules = [];
  try {
    validationRules = step.validation_rules ? JSON.parse(step.validation_rules) : [];
  } catch {
    validationRules = [];
  }

  if (!Array.isArray(validationRules) || validationRules.length === 0) {
    return { pass: true, error: null };
  }

  for (const rule of validationRules) {
    if (!rule || !rule.type) continue;

    if (rule.type === 'status') {
      const expected = rule.rule?.expected;
      if (expected !== undefined && statusCode !== expected) {
        return { pass: false, error: `Expected status ${expected}, got ${statusCode}` };
      }
    } else if (rule.type === 'body') {
      try {
        const body = await response.clone().text();
        const contains = rule.rule?.contains;
        if (contains && !body.includes(contains)) {
          return { pass: false, error: `Response body does not contain '${contains}'` };
        }
      } catch (err) {
        return { pass: false, error: `Failed to read response body: ${err.message}` };
      }
    } else if (rule.type === 'header') {
      const headerName = rule.rule?.header;
      const expectedValue = rule.rule?.expected;
      if (headerName) {
        const actual = response.headers.get(headerName);
        if (actual === null) {
          return { pass: false, error: `Expected header '${headerName}' not present` };
        }
        if (expectedValue !== undefined && actual !== expectedValue) {
          return { pass: false, error: `Header '${headerName}' expected '${expectedValue}', got '${actual}'` };
        }
      }
    }
  }

  return { pass: true, error: null };
}

/**
 * Substitutes {{variable}} placeholders in a string with shared context variables.
 */
function substituteVariables(str, variables) {
  if (!str || !variables) return str;
  return str.replace(/\{\{(\w+)\}\}/g, (match, name) => {
    return variables[name] !== undefined ? variables[name] : match;
  });
}
