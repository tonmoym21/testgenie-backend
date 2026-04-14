/**
 * API Test Runner
 * Executes API tests and evaluates assertions
 * Now with environment variable resolution support
 */

const envService = require('../services/environmentService');

/**
 * Run an API test with the given configuration
 * @param {Object} config - Test configuration
 * @param {string} config.method - HTTP method
 * @param {string} config.url - Request URL (may contain {{VAR}} placeholders)
 * @param {Object} config.headers - Request headers (values may contain {{VAR}})
 * @param {Object} config.body - Request body (values may contain {{VAR}})
 * @param {Array} config.assertions - Assertions to evaluate
 * @param {number} config.timeout - Request timeout in ms
 * @param {Object} [envVars] - Environment variables for resolution
 * @returns {Object} Test result with rawResponse, assertionResults, logs
 */
async function runApiTest(config, envVars = null) {
  const logs = [];
  const log = (level, message) => {
    logs.push({ level, message, timestamp: new Date().toISOString() });
  };

  log('info', `Starting API test: ${config.method} ${config.url}`);

  // Resolve environment variables if provided
  let resolvedConfig = config;
  if (envVars && Object.keys(envVars).length > 0) {
    resolvedConfig = envService.resolveObjectVariables(config, envVars);
    log('debug', `Resolved ${Object.keys(envVars).length} environment variables`);
  }

  const { method, url, headers = {}, body, assertions = [], timeout = 10000 } = resolvedConfig;

  const startTime = Date.now();
  let rawResponse = null;
  let assertionResults = [];

  try {
    log('info', `Sending ${method} request to ${url}`);

    // Build fetch options
    const fetchOptions = {
      method,
      headers: { ...headers },
      signal: AbortSignal.timeout(timeout),
    };

    // Add body for non-GET requests
    if (body && !['GET', 'HEAD'].includes(method.toUpperCase())) {
      if (typeof body === 'object') {
        fetchOptions.body = JSON.stringify(body);
        if (!fetchOptions.headers['Content-Type']) {
          fetchOptions.headers['Content-Type'] = 'application/json';
        }
      } else {
        fetchOptions.body = body;
      }
    }

    // Execute request
    const response = await fetch(url, fetchOptions);
    const responseTime = Date.now() - startTime;

    // Read response body
    const contentType = response.headers.get('content-type') || '';
    let responseBody;
    try {
      if (contentType.includes('application/json')) {
        responseBody = await response.json();
      } else {
        responseBody = await response.text();
      }
    } catch (e) {
      responseBody = null;
      log('warn', `Failed to parse response body: ${e.message}`);
    }

    // Build raw response object
    rawResponse = {
      statusCode: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      body: responseBody,
      responseTime,
      size: JSON.stringify(responseBody || '').length,
    };

    log('info', `Received ${response.status} ${response.statusText} in ${responseTime}ms`);

    // Evaluate assertions
    assertionResults = evaluateAssertions(assertions, rawResponse, log);

  } catch (error) {
    const responseTime = Date.now() - startTime;
    log('error', `Request failed: ${error.message}`);

    if (error.name === 'TimeoutError' || error.message.includes('timeout')) {
      rawResponse = {
        error: 'Request timed out',
        responseTime,
        statusCode: null,
        statusText: 'Timeout',
        headers: {},
        body: null,
        size: 0,
      };
    } else {
      rawResponse = {
        error: error.message,
        responseTime,
        statusCode: null,
        statusText: 'Error',
        headers: {},
        body: null,
        size: 0,
      };
    }

    // All assertions fail on request error
    assertionResults = assertions.map((a) => ({
      ...a,
      passed: false,
      message: `Request failed: ${error.message}`,
      actual: null,
    }));
  }

  // Determine overall status
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
  };
}

/**
 * Evaluate assertions against the response
 */
function evaluateAssertions(assertions, rawResponse, log) {
  return assertions.map((assertion) => {
    const { target, operator, expected, path } = assertion;
    let actual;
    let passed = false;
    let message = '';

    try {
      // Get actual value based on target
      switch (target) {
        case 'status':
          actual = rawResponse.statusCode;
          break;
        case 'response_time':
          actual = rawResponse.responseTime;
          break;
        case 'header':
          if (path) {
            actual = rawResponse.headers[path.toLowerCase()];
          } else {
            actual = rawResponse.headers;
          }
          break;
        case 'body':
          if (path) {
            actual = getNestedValue(rawResponse.body, path);
          } else {
            actual = rawResponse.body;
          }
          break;
        default:
          message = `Unknown assertion target: ${target}`;
          log('error', message);
          return { ...assertion, passed: false, message, actual: null };
      }

      // Evaluate operator
      switch (operator) {
        case 'equals':
          passed = actual == expected; // Use loose equality for flexibility
          message = passed 
            ? `${target}${path ? '.' + path : ''} equals ${JSON.stringify(expected)}`
            : `Expected ${target}${path ? '.' + path : ''} to equal ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`;
          break;
        case 'contains':
          if (typeof actual === 'string') {
            passed = actual.includes(String(expected));
          } else if (typeof actual === 'object') {
            passed = JSON.stringify(actual).includes(String(expected));
          } else {
            passed = false;
          }
          message = passed
            ? `${target}${path ? '.' + path : ''} contains "${expected}"`
            : `Expected ${target}${path ? '.' + path : ''} to contain "${expected}"`;
          break;
        case 'greater_than':
          passed = Number(actual) > Number(expected);
          message = passed
            ? `${target}${path ? '.' + path : ''} (${actual}) is greater than ${expected}`
            : `Expected ${target}${path ? '.' + path : ''} (${actual}) to be greater than ${expected}`;
          break;
        case 'less_than':
          passed = Number(actual) < Number(expected);
          message = passed
            ? `${target}${path ? '.' + path : ''} (${actual}) is less than ${expected}`
            : `Expected ${target}${path ? '.' + path : ''} (${actual}) to be less than ${expected}`;
          break;
        case 'exists':
          passed = actual !== undefined && actual !== null;
          message = passed
            ? `${target}${path ? '.' + path : ''} exists`
            : `Expected ${target}${path ? '.' + path : ''} to exist`;
          break;
        case 'matches':
          try {
            const regex = new RegExp(expected);
            passed = regex.test(String(actual));
            message = passed
              ? `${target}${path ? '.' + path : ''} matches pattern "${expected}"`
              : `Expected ${target}${path ? '.' + path : ''} to match pattern "${expected}"`;
          } catch (e) {
            passed = false;
            message = `Invalid regex pattern: ${expected}`;
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

/**
 * Get nested value from object using dot notation path
 */
function getNestedValue(obj, path) {
  if (!obj || !path) return obj;
  
  const parts = path.split('.');
  let current = obj;
  
  for (const part of parts) {
    // Handle array indices like "data.0.name" or "data[0].name"
    const match = part.match(/^(\w+)\[(\d+)\]$/);
    if (match) {
      current = current?.[match[1]]?.[parseInt(match[2])];
    } else if (part.match(/^\d+$/)) {
      current = current?.[parseInt(part)];
    } else {
      current = current?.[part];
    }
    
    if (current === undefined) return undefined;
  }
  
  return current;
}

module.exports = { runApiTest };
