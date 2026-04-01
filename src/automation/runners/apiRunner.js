const logger = require('../../utils/logger');

function getPath(obj, pathStr) {
  return pathStr.split('.').reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    return current[key];
  }, obj);
}

function evaluateAssertion(assertion, response) {
  const { target, operator, expected, path: jsonPath } = assertion;
  let actual;

  switch (target) {
    case 'status': actual = response.status; break;
    case 'body': actual = jsonPath ? getPath(response.body, jsonPath) : response.body; break;
    case 'header': actual = response.headers[jsonPath?.toLowerCase()]; break;
    case 'response_time': actual = response.responseTime; break;
    default: return { passed: false, message: 'Unknown target: ' + target };
  }

  switch (operator) {
    case 'equals':
      if (actual !== expected && JSON.stringify(actual) !== JSON.stringify(expected))
        return { passed: false, message: 'Expected ' + target + (jsonPath ? '.' + jsonPath : '') + ' to equal ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual) };
      break;
    case 'contains':
      if (typeof actual === 'string' && !actual.includes(expected))
        return { passed: false, message: 'Expected ' + target + ' to contain "' + expected + '", got "' + actual + '"' };
      if (typeof actual === 'object' && !JSON.stringify(actual).includes(expected))
        return { passed: false, message: 'Expected ' + target + ' to contain "' + expected + '"' };
      break;
    case 'greater_than':
      if (typeof actual !== 'number' || actual <= expected)
        return { passed: false, message: 'Expected ' + target + ' to be > ' + expected + ', got ' + actual };
      break;
    case 'less_than':
      if (typeof actual !== 'number' || actual >= expected)
        return { passed: false, message: 'Expected ' + target + ' to be < ' + expected + ', got ' + actual };
      break;
    case 'exists':
      if (actual === undefined || actual === null)
        return { passed: false, message: 'Expected ' + target + (jsonPath ? '.' + jsonPath : '') + ' to exist, but it is ' + actual };
      break;
    case 'matches':
      if (!new RegExp(expected).test(String(actual)))
        return { passed: false, message: 'Expected ' + target + ' to match /' + expected + '/, got "' + actual + '"' };
      break;
    default:
      return { passed: false, message: 'Unknown operator: ' + operator };
  }

  return { passed: true, message: target + (jsonPath ? '.' + jsonPath : '') + ' ' + operator + ' ' + JSON.stringify(expected) + ' -- passed' };
}

async function runApiTest(testDef) {
  const { name, config } = testDef;
  const startTime = Date.now();
  const logs = [];
  let status = 'passed';
  let errorMessage = null;
  const assertionResults = [];
  let rawResponse = null;

  const log = (level, message) => {
    const entry = { timestamp: new Date().toISOString(), level, message };
    logs.push(entry);
    logger[level]({ test: name }, message);
  };

  try {
    log('info', 'Starting API test: ' + name);
    log('info', config.method + ' ' + config.url);

    const options = {
      method: config.method,
      headers: { 'Content-Type': 'application/json', ...(config.headers || {}) },
      signal: AbortSignal.timeout(config.timeout || 10000),
    };

    if (config.body && !['GET', 'DELETE'].includes(config.method)) {
      options.body = JSON.stringify(config.body);
    }

    const requestStart = Date.now();
    const res = await fetch(config.url, options);
    const responseTime = Date.now() - requestStart;

    let body;
    const contentType = res.headers.get('content-type') || '';
    const rawText = await res.text();

    if (contentType.includes('application/json')) {
      try { body = JSON.parse(rawText); } catch { body = rawText; }
    } else {
      body = rawText;
    }

    const responseHeaders = {};
    res.headers.forEach((value, key) => { responseHeaders[key] = value; });

    // Store raw response for Postman-style viewer
    rawResponse = {
      statusCode: res.status,
      statusText: res.statusText,
      headers: responseHeaders,
      body: body,
      rawBody: rawText,
      responseTime: responseTime,
      size: rawText.length,
    };

    const response = {
      status: res.status,
      headers: responseHeaders,
      body,
      responseTime,
    };

    log('info', 'Response: ' + res.status + ' ' + res.statusText + ' (' + responseTime + 'ms, ' + rawText.length + ' bytes)');

    for (let i = 0; i < config.assertions.length; i++) {
      const assertion = config.assertions[i];
      const result = evaluateAssertion(assertion, response);
      assertionResults.push({ index: i + 1, ...assertion, ...result });

      if (result.passed) {
        log('info', 'Assertion ' + (i + 1) + ': ' + result.message);
      } else {
        log('error', 'Assertion ' + (i + 1) + ' FAILED: ' + result.message);
        status = 'failed';
        if (!errorMessage) errorMessage = result.message;
      }
    }

    if (status === 'passed') {
      log('info', 'All ' + config.assertions.length + ' assertions passed');
    } else {
      const failedCount = assertionResults.filter((a) => !a.passed).length;
      log('error', failedCount + ' of ' + config.assertions.length + ' assertions failed');
    }
  } catch (err) {
    status = 'failed';
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      errorMessage = 'Request timed out after ' + (config.timeout || 10000) + 'ms';
    } else {
      errorMessage = err.message;
    }
    log('error', 'Test failed: ' + errorMessage);
  }

  const duration = Date.now() - startTime;

  return {
    name,
    type: 'api',
    status,
    error: errorMessage,
    duration,
    assertionResults,
    rawResponse,
    logs,
    screenshots: [],
    completedAt: new Date().toISOString(),
  };
}

module.exports = { runApiTest };
