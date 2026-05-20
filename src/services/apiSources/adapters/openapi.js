// OpenAPI 3.x and Swagger 2.0 adapter.
//
// Uses @apidevtools/swagger-parser for $ref resolution and validation. The
// `dereference` step inlines all internal $refs so downstream code sees a
// flat tree. **External $ref following is disabled** via the resolve.external
// option — otherwise a malicious spec could chain to internal URLs and
// bypass our SSRF guard.

const SwaggerParser = require('@apidevtools/swagger-parser');
const yaml = require('js-yaml');
const { buildSampleUrl } = require('../ir');

const FORMAT = 'openapi';

function detect(input) {
  if (input.format === 'openapi3' || input.format === 'openapi2') {
    return { confidence: 0.99, format: input.format };
  }
  return null;
}

async function parseRaw(raw) {
  // Accept either JSON or YAML. swagger-parser handles both but we pre-parse
  // so we control the YAML safety options (FAILSAFE_SCHEMA avoids `!!js/function`
  // and other code-exec gadgets).
  // 5 MB hard cap on raw input. swagger-parser will subsequently dereference
  // and we don't want a multi-hundred-MB spec consuming the event loop.
  if (typeof raw === 'string' && raw.length > 5 * 1024 * 1024) {
    throw new Error('Spec exceeds 5 MB limit');
  }
  let doc;
  try { doc = JSON.parse(raw); }
  catch {
    // JSON_SCHEMA restricts YAML to JSON-compatible scalars only — no
    // !!js/function, !!js/regexp, !!timestamp, !!set. Strictly safer than
    // js-yaml's default DEFAULT_SCHEMA, and unlike FAILSAFE_SCHEMA it still
    // preserves numbers and booleans (which OpenAPI specs need).
    doc = yaml.load(raw, { schema: yaml.JSON_SCHEMA, json: false });
  }

  // Validate + dereference, but keep external refs OFF. swagger-parser's
  // `resolve.external = false` makes it throw on external $refs rather than
  // silently fetching them.
  const dereffed = await SwaggerParser.dereference(doc, {
    resolve: { external: false },
    dereference: { circular: 'ignore' },
  });

  return dereffed;
}

function normalizeServers(doc) {
  // OpenAPI 3: doc.servers = [{ url, description, variables }]
  // Swagger 2: host + basePath + schemes
  if (Array.isArray(doc.servers) && doc.servers.length) {
    return doc.servers.map((s) => ({
      url: s.url,
      description: s.description,
      variables: s.variables,
    }));
  }
  if (doc.host) {
    const schemes = Array.isArray(doc.schemes) && doc.schemes.length ? doc.schemes : ['https'];
    const basePath = doc.basePath || '';
    return schemes.map((scheme) => ({ url: `${scheme}://${doc.host}${basePath}` }));
  }
  return [];
}

function normalizeAuthSchemes(doc) {
  const out = [];
  // OpenAPI 3
  const compSec = doc.components && doc.components.securitySchemes;
  if (compSec) {
    for (const [name, s] of Object.entries(compSec)) {
      out.push({ name, type: s.type, scheme: s.scheme, in: s.in, bearerFormat: s.bearerFormat, flows: s.flows });
    }
  }
  // Swagger 2
  if (doc.securityDefinitions) {
    for (const [name, s] of Object.entries(doc.securityDefinitions)) {
      out.push({ name, type: s.type, scheme: s.type === 'basic' ? 'basic' : undefined, in: s.in });
    }
  }
  return out;
}

function paramsFromOperation(op, pathItem) {
  // Path-level params merge into operation params; operation params override
  // path-level by (name, in).
  const merged = new Map();
  const collect = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const p of arr) merged.set(`${p.name}|${p.in}`, p);
  };
  collect(pathItem.parameters);
  collect(op.parameters);
  return Array.from(merged.values()).map((p) => ({
    name: p.name,
    in: p.in,
    required: !!p.required,
    schema: p.schema || (p.type ? { type: p.type, format: p.format } : undefined),
    example: p.example,
    description: p.description,
  }));
}

function bodyFromOperation(op) {
  // OpenAPI 3
  if (op.requestBody && op.requestBody.content) {
    const types = Object.keys(op.requestBody.content);
    const preferred = types.find((t) => t.includes('json')) || types[0];
    const entry = op.requestBody.content[preferred] || {};
    return { contentType: preferred, schema: entry.schema, example: entry.example };
  }
  // Swagger 2: body param
  if (Array.isArray(op.parameters)) {
    const body = op.parameters.find((p) => p.in === 'body');
    if (body) return { contentType: 'application/json', schema: body.schema, example: body.example };
  }
  return null;
}

function responsesFrom(op) {
  const byStatus = {};
  if (!op.responses) return { byStatus };
  for (const [status, r] of Object.entries(op.responses)) {
    if (r && r.content) {
      const types = Object.keys(r.content);
      const preferred = types.find((t) => t.includes('json')) || types[0];
      const entry = r.content[preferred] || {};
      byStatus[status] = { description: r.description, contentType: preferred, schema: entry.schema, example: entry.example };
    } else {
      byStatus[status] = { description: r && r.description, schema: r && r.schema };
    }
  }
  return { byStatus };
}

function exampleForSchema(schema) {
  if (!schema || typeof schema !== 'object') return undefined;
  if (schema.example !== undefined) return schema.example;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  switch (schema.type) {
    case 'string':  return schema.format === 'uuid' ? '00000000-0000-0000-0000-000000000000' : 'string';
    case 'integer':
    case 'number':  return 0;
    case 'boolean': return true;
    case 'array':   return [exampleForSchema(schema.items)].filter((v) => v !== undefined);
    case 'object': {
      const out = {};
      const props = schema.properties || {};
      for (const [k, v] of Object.entries(props)) {
        const ex = exampleForSchema(v);
        if (ex !== undefined) out[k] = ex;
      }
      return out;
    }
    default: return undefined;
  }
}

function buildSample(op, pathTemplate, parameters, body, serverUrl) {
  const pathParams = parameters.filter((p) => p.in === 'path');
  const queryParams = parameters.filter((p) => p.in === 'query');
  const headerParams = parameters.filter((p) => p.in === 'header');

  let url = buildSampleUrl(serverUrl, pathTemplate, pathParams);

  if (queryParams.length) {
    const qs = queryParams
      .map((p) => `${encodeURIComponent(p.name)}={{${p.name}}}`)
      .join('&');
    url += `?${qs}`;
  }

  const headers = {};
  for (const p of headerParams) headers[p.name] = `{{${p.name}}}`;

  const sample = {
    method: (op.__method || 'GET').toUpperCase(),
    url,
    headers,
    assertions: [{ type: 'status', operator: 'lt', value: 400 }],
    extractors: [],
    timeout: 10000,
  };

  if (body && body.schema) {
    const ex = body.example !== undefined ? body.example : exampleForSchema(body.schema);
    if (ex !== undefined) sample.body = ex;
    headers['Content-Type'] = body.contentType || 'application/json';
  }
  return sample;
}

function parse(input) {
  // Accept either a pre-parsed `doc` (from the detector) or a raw string.
  const promise = input.doc
    ? Promise.resolve(input.doc)
    : parseRaw(input.raw);

  return promise.then(async (rawDoc) => {
    // Dereference even if the detector handed us a parsed doc — refs may
    // still be present.
    const doc = await SwaggerParser.dereference(rawDoc, {
      resolve: { external: false },
      dereference: { circular: 'ignore' },
    });

    const servers = normalizeServers(doc);
    const authSchemes = normalizeAuthSchemes(doc);
    const primaryServer = servers[0] && servers[0].url;
    const endpoints = [];

    const paths = doc.paths || {};
    const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'];

    for (const [pathTemplate, pathItem] of Object.entries(paths)) {
      if (!pathItem || typeof pathItem !== 'object') continue;
      for (const method of METHODS) {
        const op = pathItem[method];
        if (!op) continue;
        const opMarked = { ...op, __method: method };
        const parameters = paramsFromOperation(opMarked, pathItem);
        const body = bodyFromOperation(opMarked);
        const responses = responsesFrom(opMarked);
        const sample = buildSample(opMarked, pathTemplate, parameters, body, primaryServer);

        endpoints.push({
          protocol: 'rest',
          operationId: op.operationId,
          method: method.toUpperCase(),
          path: pathTemplate,
          summary: op.summary,
          description: op.description,
          tags: Array.isArray(op.tags) ? op.tags : [],
          authRequirement: Array.isArray(op.security) ? op.security : [],
          requestSchema: { parameters, body: body || undefined },
          responseSchema: responses,
          sampleRequest: sample,
          bindings: op.servers ? { servers: op.servers } : undefined,
          examples: [],
          vendorExtensions: extractVendorExt(op),
          deprecated: !!op.deprecated,
        });
      }
    }

    return {
      name: (doc.info && doc.info.title) || 'Imported API',
      protocol: 'rest',
      format: doc.openapi ? 'openapi3' : 'openapi2',
      specVersion: doc.openapi || doc.swagger,
      servers,
      authSchemes,
      endpoints,
    };
  });
}

function extractVendorExt(obj) {
  const out = {};
  for (const k of Object.keys(obj || {})) {
    if (k.startsWith('x-')) out[k] = obj[k];
  }
  return out;
}

module.exports = { FORMAT, detect, parse };
