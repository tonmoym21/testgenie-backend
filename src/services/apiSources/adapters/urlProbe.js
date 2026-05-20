// URL-probe adapter.
//
// User pastes a bare URL (e.g. https://api.example.com). We try a small set
// of well-known spec endpoints; if any of them comes back with parseable
// OpenAPI/Swagger, we delegate to the OpenAPI adapter. If nothing parses,
// we register the URL as a single-endpoint source (a `GET` to that exact
// URL) so the user can at least run a smoke test.
//
// The fetcher used here is the same SSRF-safe one used for direct URL
// imports, so probing private/loopback ranges is blocked.

const { fetchSpec } = require('../fetcher');
const { detectFromText } = require('../detector');
const openapi = require('./openapi');
const logger = require('../../../utils/logger');

const FORMAT = 'url_probe';

const PROBES = [
  '/openapi.json',
  '/openapi.yaml',
  '/swagger.json',
  '/swagger/v1/swagger.json',
  '/api-docs',
  '/v3/api-docs',
  '/.well-known/openapi',
];

function detect(input) {
  if (input.format === 'url_probe') return { confidence: 0.9, format: 'url_probe' };
  return null;
}

async function tryProbe(base) {
  for (const probe of PROBES) {
    const url = base.replace(/\/$/, '') + probe;
    try {
      const res = await fetchSpec(url);
      if (res.status !== 200 || !res.body || !res.body.length) continue;
      const text = res.body.toString('utf8');
      const detected = detectFromText(text);
      if (detected && (detected.format === 'openapi3' || detected.format === 'openapi2')) {
        logger.info({ probe: url }, 'apiSource urlProbe: discovered spec');
        return { specText: text, specUrl: url, detected };
      }
    } catch (err) {
      logger.debug({ url, err: err.message }, 'apiSource urlProbe: probe failed');
    }
  }
  return null;
}

async function parse(input) {
  const baseUrl = (input.raw || '').trim();
  if (!/^https?:\/\//.test(baseUrl)) throw new Error('URL probe: expected an http(s) URL');

  const probed = await tryProbe(baseUrl);
  if (probed) {
    const ir = await openapi.parse({ format: probed.detected.format, doc: probed.detected.doc, raw: probed.specText });
    return {
      ...ir,
      format: probed.detected.format,
      sourceUrl: probed.specUrl,
    };
  }

  // No spec found at common paths. Register the URL itself as a single
  // probe endpoint — the user can still pick it and run a smoke test.
  let path = '/';
  let server = baseUrl;
  try {
    const u = new URL(baseUrl);
    server = `${u.protocol}//${u.host}`;
    path = u.pathname + (u.search || '') || '/';
  } catch { /* noop */ }

  const endpoint = {
    protocol: 'rest',
    method: 'GET',
    path,
    summary: `GET ${baseUrl}`,
    description: 'No spec discovered at common locations; registered as single-URL probe.',
    tags: ['probe'],
    authRequirement: [],
    requestSchema: { parameters: [] },
    responseSchema: { byStatus: {} },
    sampleRequest: {
      method: 'GET',
      url: baseUrl,
      headers: {},
      assertions: [{ type: 'status', operator: 'lt', value: 500 }],
      extractors: [],
      timeout: 10000,
    },
    examples: [],
  };

  return {
    name: `Probe: ${baseUrl}`,
    protocol: 'rest',
    format: 'url_probe',
    servers: [{ url: server }],
    authSchemes: [],
    endpoints: [endpoint],
    sourceUrl: baseUrl,
  };
}

module.exports = { FORMAT, detect, parse };
