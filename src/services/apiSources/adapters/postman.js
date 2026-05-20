// Postman v2.1 collection adapter.
//
// Postman collections nest items in arbitrary folder depth. We flatten,
// scan for baked-in secrets (Bearer tokens, API keys, anything matching
// our heuristics) and replace with {{secret:N}} placeholders. The findings
// list bubbles up so the route handler can surface a "secrets detected"
// banner to the user.

const { scanAndRedact } = require('../secretScanner');
const { buildSampleUrl } = require('../ir');

const FORMAT = 'postman21';

function detect(input) {
  if (input.format === 'postman21') return { confidence: 0.99, format: 'postman21' };
  return null;
}

function urlFromPostman(u) {
  // Postman url can be a string or { raw, protocol, host[], path[], query[], variable[] }
  if (!u) return { url: '', queryParams: [], pathVars: [] };
  if (typeof u === 'string') return { url: u, queryParams: [], pathVars: [] };

  const protocol = u.protocol ? `${u.protocol}://` : '';
  const host = Array.isArray(u.host) ? u.host.join('.') : (u.host || '');
  const port = u.port ? `:${u.port}` : '';
  const pathParts = Array.isArray(u.path) ? u.path : (u.path ? [u.path] : []);
  const pathStr = '/' + pathParts.join('/').replace(/^\/+/, '');

  // Variables in path are usually written as :name in Postman — normalise to {name}.
  const normPath = pathStr.replace(/:([A-Za-z0-9_]+)/g, '{$1}');

  const url = `${protocol}${host}${port}${normPath}`;
  const queryParams = Array.isArray(u.query) ? u.query.filter((q) => !q.disabled).map((q) => ({ name: q.key, value: q.value })) : [];
  const pathVars = Array.isArray(u.variable) ? u.variable.map((v) => ({ name: v.key, value: v.value })) : [];

  return { url, queryParams, pathVars };
}

function authToScheme(auth) {
  if (!auth || typeof auth !== 'object') return null;
  const type = auth.type;
  if (!type) return null;
  // Postman shapes the type-specific config under auth[type] as either an
  // array of {key,value} or an object — collapse to a flat object.
  const cfg = auth[type];
  let flat = {};
  if (Array.isArray(cfg)) flat = Object.fromEntries(cfg.map((kv) => [kv.key, kv.value]));
  else if (cfg && typeof cfg === 'object') flat = cfg;
  return { name: `postman-${type}`, type, config: flat };
}

function bodyFromItem(req) {
  const body = req.body;
  if (!body || body.disabled) return null;
  switch (body.mode) {
    case 'raw': {
      const lang = body.options && body.options.raw && body.options.raw.language;
      let parsed = body.raw;
      if (lang === 'json' || (typeof body.raw === 'string' && /^[\[{]/.test(body.raw.trim()))) {
        try { parsed = JSON.parse(body.raw); } catch { /* keep as string */ }
      }
      return { contentType: lang === 'json' ? 'application/json' : 'text/plain', example: parsed };
    }
    case 'urlencoded':
    case 'formdata': {
      const fields = (body[body.mode] || []).filter((p) => !p.disabled);
      return {
        contentType: body.mode === 'urlencoded' ? 'application/x-www-form-urlencoded' : 'multipart/form-data',
        example: Object.fromEntries(fields.map((p) => [p.key, p.value])),
      };
    }
    case 'file':
    case 'graphql':
    case 'binary':
    default:
      return null;
  }
}

function* walkItems(items, prefix = []) {
  if (!Array.isArray(items)) return;
  for (const item of items) {
    if (Array.isArray(item.item)) {
      // Folder
      yield* walkItems(item.item, prefix.concat(item.name || 'Folder'));
    } else if (item.request) {
      yield { item, folderPath: prefix };
    }
  }
}

function parse(input) {
  const docRaw = input.doc || (input.raw ? JSON.parse(input.raw) : null);
  if (!docRaw) throw new Error('Postman adapter: no input document');

  // Scrub secrets BEFORE doing any other processing, so they never travel
  // through the rest of the pipeline.
  const { redacted: doc, findings: secretFindings } = scanAndRedact(docRaw);

  const collectionName = (doc.info && doc.info.name) || 'Postman Import';
  const endpoints = [];
  const inferredServers = new Set();

  for (const { item, folderPath } of walkItems(doc.item || [])) {
    const req = item.request || {};
    const method = (req.method || 'GET').toUpperCase();
    const { url, queryParams, pathVars } = urlFromPostman(req.url);

    // Try to split the URL into a base + path so the catalog records a
    // sensible server. If the URL has {{baseUrl}} or similar, just use the
    // whole string as the path.
    let pathTemplate = url;
    let server;
    try {
      // Replace {{var}} in URL temporarily so URL parser can handle it.
      const fakeProto = url.replace(/\{\{[^}]+\}\}/g, 'placeholder');
      const u = new URL(fakeProto);
      server = `${u.protocol}//${u.host}`;
      // WHATWG URL parser percent-encodes `{` / `}` in pathname. Decode so
      // the catalog stores the human-readable template (`/users/{id}`) and
      // the fingerprint canonicaliser sees the placeholder, not `%7Bid%7D`.
      pathTemplate = decodeURI(u.pathname) + (u.search || '');
      inferredServers.add(server);
    } catch {
      // URL contains {{baseUrl}} or is malformed — keep as-is.
    }

    const parameters = [
      ...pathVars.map((p) => ({ name: p.name, in: 'path', required: true, example: p.value })),
      ...queryParams.map((q) => ({ name: q.name, in: 'query', example: q.value })),
      ...((req.header || []).filter((h) => !h.disabled).map((h) => ({
        name: h.key, in: 'header', example: h.value,
      }))),
    ];

    const body = bodyFromItem(req);
    const headers = {};
    for (const h of req.header || []) {
      if (!h.disabled && h.key) headers[h.key] = h.value;
    }

    const sample = {
      method,
      url,
      headers,
      assertions: [{ type: 'status', operator: 'lt', value: 400 }],
      extractors: [],
      timeout: 10000,
    };
    if (body && body.example !== undefined) sample.body = body.example;

    endpoints.push({
      protocol: 'rest',
      operationId: item.name,
      method,
      path: pathTemplate || '/',
      summary: item.name,
      description: typeof req.description === 'string' ? req.description : (req.description && req.description.content),
      tags: folderPath,
      authRequirement: req.auth ? [authToScheme(req.auth)].filter(Boolean) : [],
      requestSchema: { parameters, body: body || undefined },
      responseSchema: { byStatus: {} },
      sampleRequest: sample,
      examples: Array.isArray(item.response) ? item.response.slice(0, 3).map((r) => ({
        name: r.name, status: r.code, body: r.body,
      })) : [],
    });
  }

  return Promise.resolve({
    name: collectionName,
    protocol: 'rest',
    format: 'postman21',
    specVersion: '2.1.0',
    servers: Array.from(inferredServers).map((url) => ({ url })),
    authSchemes: doc.auth ? [authToScheme(doc.auth)].filter(Boolean) : [],
    endpoints,
    // Provenance: secret findings get attached so the orchestration layer
    // can persist them onto api_sources.provenance for the UI banner.
    __provenance: { secretFindings },
  });
}

module.exports = { FORMAT, detect, parse };
