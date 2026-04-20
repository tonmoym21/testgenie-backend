/**
 * API Test Runner — v2.3
 * JSON payload ONLY: form-data and raw string bodies are rejected.
 * Response body is always parsed as JSON when content-type allows.
 */

const envService = require('../../services/environmentService');

/**
 * Run an API test.
 * @param {Object} config       - Test configuration (method, url, headers, body, assertions, timeout)
 * @param {Object} [envVars]    - Pre-resolved variable map (env + globals + chain vars)
 * @returns {Object} result     - { rawResponse, assertionResults, logs, status, duration, error, extractedVars }
 */
async function runApiTest(config, envVars = null) {
  const logs = [];
  const log = (level, message) => logs.push({ level, message, timestamp: new Date().toISOString() });

  log('info', `Starting API test: ${config.method} ${config.url}`);

  // Resolve all {{...}} tokens using the merged variable context
  let resolvedConfig = config;
  if (envVars && Object.keys(envVars).length > 0) {
    resolvedConfig = envService.resolveObjectVariables(config, envVars);
    log('debug', `Resolved ${Object.keys(envVars).length} variables`);
  }

  const { method, url, headers = {}, body, assertions = [], timeout = 10000, extractors = [] } = resolvedConfig;

  const startTime = Date.now();
  let rawResponse = null;
  let assertionResults = [];
  let extractedVars = {};

  try {
    log('info', `Sending ${method} request to ${url}`);

    const fetchOptions = {
      method,
      headers: { ...headers },
      signal: AbortSignal.timeout(timeout),
    };

    // JSON-only: reject anything that isn't a plain object/array
    if (body !== undefined && body !== null && !['GET', 'HEAD'].includes(method.toUpperCase())) {
      if (typeof body === 'string') {
        // Disallow raw string bodies — must be valid JSON text representing an object/array
        try {
          const parsed = JSON.parse(body);
          fetchOptions.body = JSON.stringify(parsed);
        } catch {
          throw new Error('Request body must be valid JSON. Raw string and form-data bodies are not supported.');
        }
      } else if (typeof body === 'object') {
        fetchOptions.body = JSON.stringify(body);
      } else {
        throw new Error('Request body must be a JSON object or array.');
      }
      // Always enforce JSON content-type
      fetchOptions.headers['Content-Type'] = 'application/json';
    }

    const response = await fetch(url, fetchOptions);
    const responseTime = Date.now() - startTime;

    const contentType = response.headers.get('content-type') || '';
    let responseBody;
    try {
      if (contentType.includes('application/json') || contentType.includes('text/json')) {
        responseBody = await response.json();
      } else {
        const text = await response.text();
        // Try to parse as JSON even when content-type is text/*
        try { responseBody = JSON.parse(text); } catch { responseBody = text; }
      }
    } catch (e) {
      responseBody = null;
      log('warn', `Failed to parse response body: ${e.message}`);
    }

    rawResponse = {
      statusCode: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody,
      responseTime,
      size: JSON.stringify(responseBody ?? '').length,
    };

    log('info', `Received ${response.status} ${response.statusText} in ${responseTime}ms`);

    assertionResults = evaluateAssertions(assertions, rawResponse, log);

    // Run extractors for response chaining: [{name: "userId", path: "data.id"}]
    if (extractors.length > 0 && responseBody && typeof responseBody === 'object') {
      for (const ex of extractors) {
        const val = getNestedValue(responseBody, ex.path);
        if (val !== undefined) {
          extractedVars[ex.name] = String(val);
          log('debug', `Extracted ${ex.name} = ${extractedVars[ex.name]}`);
        } else {
          log('warn', `Extractor "${ex.name}": path "${ex.path}" not found in response`);
        }
      }
    }

  } catch (error) {
    const responseTime = Date.now() - startTime;
    log('error', `Request failed: ${error.message}`);

    rawResponse = {
      error: error.message,
      responseTime,
      statusCode: null,
      statusText: error.name === 'TimeoutError' ? 'Timeout' : 'Error',
      headers: {},
      body: null,
      size: 0,
    };

    assertionResults = assertions.map((a) => ({
      ...a,
      passed: false,
      message: `Request failed: ${error.message}`,
      actual: null,
    }));
  }

  const allPassed = assertionResults.every((r) => r.passed);
  const status = allPassed ? 'passed' : 'failed';

  log('info', `Test ${status}: ${assertionResults.filter((r) => r.passed).length}/${assertionResults.length} assertions passed`);

  return {
    rawResponse,
    assertionResults,
    logs,
    status,
    duration: rawResponse.responseTime,
    error: allPassed ? null : assertionResults.find((r) => !r.passed)?.message,
    extractedVars,
  };
}

function evaluateAssertions(assertions, rawResponse, log) {
  return assertions.map((assertion) => {
    const { target, operator, expected, path } = assertion;
    let actual;
    let passed = false;
    let message = '';

    try {
      switch (target) {
        case 'status':
          actual = rawResponse.statusCode;
          break;
        case 'response_time':
          actual = rawResponse.responseTime;
          break;
        case 'header':
          actual = path ? rawResponse.headers[path.toLowerCase()] : rawResponse.headers;
          break;
        case 'body':
          actual = path ? getNestedValue(rawResponse.body, path) : rawResponse.body;
          break;
        default:
          message = `Unknown assertion target: ${target}`;
          log('error', message);
          return { ...assertion, passed: false, message, actual: null };
      }

      switch (operator) {
        case 'equals':
          passed = actual == expected;
          message = passed
            ? `${target}${path ? '.' + path : ''} equals ${JSON.stringify(expected)}`
            : `Expected ${target}${path ? '.' + path : ''} to equal ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
          break;
        case 'contains':
          if (typeof actual === 'string') {
            passed = actual.includes(String(expected));
          } else if (typeof actual === 'object') {
            passed = JSON.stringify(actual).includes(String(expected));
          }
          message = passed
            ? `${target}${path ? '.' + path : ''} contains "${expected}"`
            : `Expected ${target}${path ? '.' + path : ''} to contain "${expected}"`;
          break;
        case 'greater_than':
          passed = Number(actual) > Number(expected);
          message = passed
            ? `${target}${path ? '.' + path : ''} (${actual}) > ${expected}`
            : `Expected ${target}${path ? '.' + path : ''} (${actual}) to be > ${expected}`;
          break;
        case 'less_than':
          passed = Number(actual) < Number(expected);
          message = passed
            ? `${target}${path ? '.' + path : ''} (${actual}) < ${expected}`
            : `Expected ${target}${path ? '.' + path : ''} (${actual}) to be < ${expected}`;
          break;
        case 'exists':
          passed = actual !== undefined && actual !== null;
          message = passed
            ? `${target}${path ? '.' + path : ''} exists`
            : `Expected ${target}${path ? '.' + path : ''} to exist`;
          break;
        case 'matches':
          try {
            passed = new RegExp(expected).test(String(actual));
            message = passed
              ? `${target}${path ? '.' + path : ''} matches /${expected}/`
              : `Expected ${target}${path ? '.' + path : ''} to match /${expected}/`;
          } catch {
            passed = false;
            message = `Invalid regex: ${expected}`;
          }
          break;
        default:
          message = `Unknown operator: ${operator}`;
          log('error', message);
      }

      log(passed ? 'info' : 'warn', message);
    } catch (error) {
      passed = false;
      message = `Assertion error: ${error.message}`;
      log('error', message);
    }

    return { ...assertion, passed, message, actual };
  });
}

function getNestedValue(obj, path) {
  if (!obj || !path) return obj;
  const parts = path.split('.');
  let current = obj;
  for (const part of parts) {
    const arrayMatch = part.match(/^(\w+)\[(\d+)\]$/);
    if (arrayMatch) {
      current = current?.[arrayMatch[1]]?.[parseInt(arrayMatch[2])];
    } else if (/^\d+$/.test(part)) {
      current = current?.[parseInt(part)];
    } else {
      current = current?.[part];
    }
    if (current === undefined) return undefined;
  }
  return current;
}

module.exports = { runApiTest };
