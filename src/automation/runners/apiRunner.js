/**
 * API Test Runner — v2.4
 * Supports Postman-style body modes: none, json, raw, form-data, urlencoded, graphql.
 * Response body is parsed as JSON when content-type allows.
 */

function hasContentTypeHeader(headers) {
  return Object.keys(headers || {}).some((k) => k.toLowerCase() === 'content-type');
}

function deleteContentTypeHeader(headers) {
  for (const k of Object.keys(headers || {})) {
    if (k.toLowerCase() === 'content-type') delete headers[k];
  }
}

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

  // Tolerate both shapes:
  //  - flat: { method, url, headers, ... }
  //  - envelope: { name, type, config: { method, url, ... } }
  // Collection / schedule runs hand us the envelope; direct calls hand us the flat config.
  const inner = (config && typeof config === 'object' && config.config && typeof config.config === 'object')
    ? config.config
    : config;

  log('info', `Starting API test: ${inner.method} ${inner.url}`);

  // Resolve all {{...}} tokens using the merged variable context
  let resolvedConfig = inner;
  if (envVars && Object.keys(envVars).length > 0) {
    resolvedConfig = envService.resolveObjectVariables(inner, envVars);
    log('debug', `Resolved ${Object.keys(envVars).length} variables`);
  }

  const {
    method, url, headers = {}, body, assertions = [], timeout = 10000, extractors = [], auth = null,
    bodyType, rawLanguage, formData: formDataFields, urlEncoded: urlEncodedFields, graphql,
    binary,
    // Chain integration — set by the collection runner; never user-supplied.
    _chainCookieHeader = null,
    _captureRedirectCookies = false,
  } = resolvedConfig;
  const effectiveBodyType = bodyType
    || (body !== undefined && body !== null ? 'json' : 'none');

  const startTime = Date.now();
  let rawResponse = null;
  let assertionResults = [];
  let extractedVars = {};
  // Aggregated Set-Cookie strings from every hop of any redirect chain we follow.
  // The orchestrator ingests these into the chain jar.
  const aggregatedSetCookies = [];

  try {
    // Optional pre-flight: POST Basic credentials to a login URL to capture session cookies.
    let sessionCookie = null;
    if (auth && auth.type === 'basic' && auth.loginUrl) {
      try {
        log('info', `Pre-flight basic auth login: POST ${auth.loginUrl}`);
        const basicHeader = 'Basic ' + Buffer.from(`${auth.username || ''}:${auth.password || ''}`).toString('base64');
        const loginRes = await fetch(auth.loginUrl, {
          method: 'POST',
          headers: { Authorization: basicHeader },
          signal: AbortSignal.timeout(timeout),
          redirect: 'manual',
        });
        const setCookie = loginRes.headers.get('set-cookie');
        if (setCookie) {
          sessionCookie = setCookie.split(/,(?=[^;]+=)/).map((c) => c.split(';')[0].trim()).join('; ');
          log('info', `Captured session cookie from login response (${loginRes.status})`);
        } else {
          log('warn', `Login response (${loginRes.status}) returned no Set-Cookie header`);
        }
      } catch (loginErr) {
        log('warn', `Login pre-flight failed: ${loginErr.message}`);
      }
    }

    log('info', `Sending ${method} request to ${url}`);

    const fetchOptions = {
      method,
      headers: { ...headers },
      signal: AbortSignal.timeout(timeout),
    };
    // Merge cookie sources, in precedence order (later wins on conflict):
    //   1. user-supplied Cookie header (lowest)
    //   2. basic-auth pre-flight sessionCookie
    //   3. chain jar (highest — auto-managed)
    {
      const parts = [];
      const existing = fetchOptions.headers['Cookie'] || fetchOptions.headers['cookie'];
      if (existing) parts.push(existing);
      if (sessionCookie) parts.push(sessionCookie);
      if (_chainCookieHeader) parts.push(_chainCookieHeader);
      if (parts.length) {
        delete fetchOptions.headers['cookie'];
        fetchOptions.headers['Cookie'] = parts.join('; ');
      }
    }

    if (!['GET', 'HEAD'].includes(method.toUpperCase()) && effectiveBodyType !== 'none') {
      if (effectiveBodyType === 'json') {
        if (body !== undefined && body !== null) {
          let payload;
          if (typeof body === 'string') {
            try { payload = JSON.stringify(JSON.parse(body)); }
            catch { throw new Error('Request body must be valid JSON.'); }
          } else if (typeof body === 'object') {
            payload = JSON.stringify(body);
          } else {
            throw new Error('Request body must be a JSON object or array.');
          }
          fetchOptions.body = payload;
          if (!hasContentTypeHeader(fetchOptions.headers)) {
            fetchOptions.headers['Content-Type'] = 'application/json';
          }
        }
      } else if (effectiveBodyType === 'raw') {
        const raw = typeof body === 'string' ? body : '';
        fetchOptions.body = raw;
        if (!hasContentTypeHeader(fetchOptions.headers)) {
          const langMap = {
            json: 'application/json',
            xml: 'application/xml',
            html: 'text/html',
            javascript: 'application/javascript',
            text: 'text/plain',
          };
          fetchOptions.headers['Content-Type'] = langMap[rawLanguage] || 'text/plain';
        }
      } else if (effectiveBodyType === 'urlencoded') {
        const params = new URLSearchParams();
        for (const f of urlEncodedFields || []) {
          if (f && f.key && f.enabled !== false) params.append(f.key, f.value == null ? '' : String(f.value));
        }
        fetchOptions.body = params.toString();
        if (!hasContentTypeHeader(fetchOptions.headers)) {
          fetchOptions.headers['Content-Type'] = 'application/x-www-form-urlencoded';
        }
      } else if (effectiveBodyType === 'form-data') {
        const fd = new FormData();
        for (const f of formDataFields || []) {
          if (!f || !f.key || f.enabled === false) continue;
          if (f.type === 'file' && f.file && f.file.data) {
            const buf = Buffer.from(f.file.data, 'base64');
            const blob = new Blob([buf], { type: f.file.mimeType || 'application/octet-stream' });
            fd.append(f.key, blob, f.file.filename || 'file');
          } else {
            fd.append(f.key, f.value == null ? '' : String(f.value));
          }
        }
        fetchOptions.body = fd;
        // Let fetch set Content-Type with the multipart boundary.
        deleteContentTypeHeader(fetchOptions.headers);
      } else if (effectiveBodyType === 'binary') {
        if (!binary || !binary.data) throw new Error('Binary body requires a file.');
        fetchOptions.body = Buffer.from(binary.data, 'base64');
        if (!hasContentTypeHeader(fetchOptions.headers)) {
          fetchOptions.headers['Content-Type'] = binary.mimeType || 'application/octet-stream';
        }
      } else if (effectiveBodyType === 'graphql') {
        const query = (graphql && graphql.query) || '';
        let variables = (graphql && graphql.variables) || {};
        if (typeof variables === 'string') {
          try { variables = JSON.parse(variables); } catch { variables = {}; }
        }
        fetchOptions.body = JSON.stringify({ query, variables });
        if (!hasContentTypeHeader(fetchOptions.headers)) {
          fetchOptions.headers['Content-Type'] = 'application/json';
        }
      }
    }

    // When chaining is active, follow redirects manually so we can capture
    // Set-Cookie set on intermediate 3xx hops. Otherwise let fetch handle it.
    let response;
    if (_captureRedirectCookies) {
      fetchOptions.redirect = 'manual';
      let currentUrl = url;
      let currentOpts = fetchOptions;
      const maxHops = 10;
      for (let hop = 0; hop < maxHops; hop++) {
        response = await fetch(currentUrl, currentOpts);
        const hopSetCookie = (typeof response.headers.getSetCookie === 'function')
          ? response.headers.getSetCookie()
          : (response.headers.get('set-cookie') ? response.headers.get('set-cookie').split(/,(?=[^;]+=)/) : []);
        for (const sc of hopSetCookie) aggregatedSetCookies.push({ url: currentUrl, raw: sc });

        // Follow 3xx with a Location header
        const status = response.status;
        const loc = response.headers.get('location');
        const isRedirect = status >= 300 && status < 400 && loc;
        if (!isRedirect) break;

        const nextUrl = new URL(loc, currentUrl).toString();
        // Per fetch spec: 301/302/303 downgrade to GET and drop body; 307/308 preserve.
        const downgrade = (status === 301 || status === 302 || status === 303);
        currentOpts = {
          ...currentOpts,
          method: downgrade ? 'GET' : currentOpts.method,
          body: downgrade ? undefined : currentOpts.body,
          headers: { ...currentOpts.headers },
        };
        if (downgrade) delete currentOpts.headers['Content-Type'];
        currentUrl = nextUrl;
      }
    } else {
      response = await fetch(url, fetchOptions);
    }
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

    // Capture Set-Cookie from the final response — Headers.entries() collapses duplicates.
    let finalSetCookieList = [];
    if (typeof response.headers.getSetCookie === 'function') {
      finalSetCookieList = response.headers.getSetCookie();
    } else {
      const raw = response.headers.get('set-cookie');
      if (raw) finalSetCookieList = raw.split(/,(?=[^;]+=)/);
    }
    // If we followed redirects manually, the aggregated list already contains
    // every hop including the final one. Otherwise seed it with the final hop.
    if (!_captureRedirectCookies) {
      for (const sc of finalSetCookieList) aggregatedSetCookies.push({ url, raw: sc });
    }

    // Flat name→value map of cookies parsed from the final response (UI display)
    const cookies = {};
    for (const sc of finalSetCookieList) {
      const [pair] = sc.split(';');
      const eq = pair.indexOf('=');
      if (eq > 0) cookies[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
    }

    rawResponse = {
      statusCode: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers.entries()),
      cookies,
      // Per-hop raw Set-Cookie strings for the chain jar to ingest. Not for UI.
      setCookieRaw: aggregatedSetCookies,
      body: responseBody,
      responseTime,
      size: JSON.stringify(responseBody ?? '').length,
    };

    log('info', `Received ${response.status} ${response.statusText} in ${responseTime}ms`);

    assertionResults = evaluateAssertions(assertions, rawResponse, log);

    // Run extractors for response chaining.
    // source: "body" (JSON path, default), "header" (header name),
    //         "cookie" (cookie name from Set-Cookie header),
    //         "body-cookies" (path → object on body; each key/value is fed
    //         into the chain cookie jar as a synthetic Set-Cookie — for APIs
    //         that return their session as JSON instead of Set-Cookie).
    if (extractors.length > 0) {
      for (const ex of extractors) {
        const source = ex.source || 'body';

        if (source === 'body-cookies') {
          // `path` resolves to an object in the response body; each entry
          // becomes a `name=value` cookie pushed onto the same aggregated
          // Set-Cookie list the chain orchestrator already ingests.
          const bag = (responseBody && typeof responseBody === 'object')
            ? getNestedValue(responseBody, ex.path)
            : null;
          if (bag && typeof bag === 'object' && !Array.isArray(bag)) {
            let pushed = 0;
            for (const [name, value] of Object.entries(bag)) {
              if (value == null) continue;
              // Quote values containing characters that would break parsing;
              // tough-cookie ingestSetCookies tolerates either form.
              const raw = `${name}=${String(value)}; Path=/`;
              aggregatedSetCookies.push({ url, raw });
              pushed += 1;
            }
            // Mirror these into rawResponse.cookies so the UI Cookies tab
            // shows them alongside any real Set-Cookie cookies.
            for (const [name, value] of Object.entries(bag)) {
              if (value == null) continue;
              rawResponse.cookies[name] = String(value);
            }
            log('debug', `body-cookies extractor ingested ${pushed} cookie(s) from body.${ex.path}`);
          } else {
            log('warn', `Extractor "${ex.name || 'body-cookies'}": body path "${ex.path}" did not resolve to an object`);
          }
          continue;
        }

        let val;
        if (source === 'header') {
          // Header lookup is case-insensitive — Headers normalises to lower-case keys.
          val = rawResponse.headers[ex.path.toLowerCase()];
        } else if (source === 'cookie') {
          // 1) Real Set-Cookie cookies first (the textbook case).
          val = rawResponse.cookies[ex.path];
          // 2) Fallback for APIs that return their session in the JSON body
          //    under a `cookie` / `cookies` field instead of Set-Cookie. Walk
          //    the most common shapes so users with source=cookie aren't
          //    silently empty-handed on engagedly-style APIs.
          if ((val == null) && responseBody && typeof responseBody === 'object') {
            const bodyBags = [
              responseBody.cookie,
              responseBody.cookies,
              responseBody.data && responseBody.data.cookie,
              responseBody.data && responseBody.data.cookies,
            ];
            for (const bag of bodyBags) {
              if (bag && typeof bag === 'object') {
                const candidate = getNestedValue(bag, ex.path);
                if (candidate !== undefined && candidate !== null) {
                  val = (typeof candidate === 'object' && candidate.value !== undefined)
                    ? candidate.value
                    : candidate;
                  log('debug', `cookie extractor "${ex.name}" resolved from body fallback`);
                  break;
                }
              }
            }
          }
        } else {
          // body
          if (responseBody && typeof responseBody === 'object') {
            val = getNestedValue(responseBody, ex.path);
          }
        }
        if (val !== undefined && val !== null) {
          extractedVars[ex.name] = String(val);
          log('debug', `Extracted ${ex.name} (${source}:${ex.path}) = ${extractedVars[ex.name]}`);
        } else {
          log('warn', `Extractor "${ex.name}": ${source} "${ex.path}" not found in response`);
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
