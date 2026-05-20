// Pure-function tests for the API source import pipeline.
// No DB, no network — adapters parse fixtures into IR.

const { detectFromText } = require('../src/services/apiSources/detector');
const { endpointFingerprint, canonicalizePath } = require('../src/services/apiSources/fingerprint');
const { scanAndRedact } = require('../src/services/apiSources/secretScanner');
const openapi = require('../src/services/apiSources/adapters/openapi');
const postman = require('../src/services/apiSources/adapters/postman');
const curl = require('../src/services/apiSources/adapters/curl');
const { isPrivateIPv4 } = require('../src/services/apiSources/fetcher');

// ──────────────────────────── detector ────────────────────────────

describe('detectFromText', () => {
  it('detects OpenAPI 3', () => {
    const r = detectFromText(JSON.stringify({ openapi: '3.0.0', info: { title: 'X' }, paths: {} }));
    expect(r.format).toBe('openapi3');
  });
  it('detects Swagger 2', () => {
    const r = detectFromText(JSON.stringify({ swagger: '2.0', info: { title: 'X' }, paths: {} }));
    expect(r.format).toBe('openapi2');
  });
  it('detects Postman v2.1', () => {
    const r = detectFromText(JSON.stringify({ info: { _postman_id: 'abc', name: 'X', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' }, item: [] }));
    expect(r.format).toBe('postman21');
  });
  it('detects curl', () => {
    const r = detectFromText('curl -X GET https://api.example.com/users');
    expect(r.format).toBe('curl');
  });
  it('detects bare URL', () => {
    const r = detectFromText('https://api.example.com');
    expect(r.format).toBe('url_probe');
  });
  it('returns json_unknown for unrecognised JSON', () => {
    const r = detectFromText('{"foo":"bar"}');
    expect(r.format).toBe('json_unknown');
  });
  it('returns null for garbage', () => {
    expect(detectFromText('not json or yaml')).toBeNull();
  });
});

// ──────────────────────────── fingerprint ────────────────────────────

describe('endpointFingerprint', () => {
  it('is stable across path-variable renames', () => {
    const a = endpointFingerprint({ method: 'GET', path: '/users/{id}',     server: 'https://x.com' });
    const b = endpointFingerprint({ method: 'GET', path: '/users/{userId}', server: 'https://x.com' });
    expect(a).toBe(b);
  });
  it('differs across servers', () => {
    const a = endpointFingerprint({ method: 'GET', path: '/u', server: 'https://a.com' });
    const b = endpointFingerprint({ method: 'GET', path: '/u', server: 'https://b.com' });
    expect(a).not.toBe(b);
  });
  it('normalises trailing slashes on servers', () => {
    const a = endpointFingerprint({ method: 'GET', path: '/u', server: 'https://x.com'  });
    const b = endpointFingerprint({ method: 'GET', path: '/u', server: 'https://x.com/' });
    expect(a).toBe(b);
  });
  it('treats /:id and /{id} the same', () => {
    expect(canonicalizePath('/users/{id}')).toBe(canonicalizePath('/users/:id'));
  });
});

// ──────────────────────────── secret scanner ────────────────────────────

describe('scanAndRedact', () => {
  it('redacts a Bearer JWT in a header value', () => {
    const input = {
      header: [{ key: 'Authorization', value: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4f' }],
    };
    const { redacted, findings } = scanAndRedact(input);
    expect(findings.length).toBeGreaterThan(0);
    expect(redacted.header[0].value).toMatch(/^Bearer \{\{secret:\d+\}\}$|^\{\{secret:\d+\}\}$/);
  });
  it('redacts an AWS access key', () => {
    const { findings } = scanAndRedact({ token: 'AKIAIOSFODNN7EXAMPLE' });
    expect(findings.some((f) => f.kinds.includes('aws_access_key_id'))).toBe(true);
  });
  it('leaves template placeholders alone', () => {
    const { findings, redacted } = scanAndRedact({ header: [{ key: 'Authorization', value: '{{authToken}}' }] });
    expect(findings).toHaveLength(0);
    expect(redacted.header[0].value).toBe('{{authToken}}');
  });
});

// ──────────────────────────── OpenAPI adapter ────────────────────────────

const PETSTORE_MINI = {
  openapi: '3.0.0',
  info: { title: 'Petstore', version: '1.0.0' },
  servers: [{ url: 'https://petstore.example.com/v1' }],
  paths: {
    '/pets': {
      get:  { operationId: 'listPets', summary: 'List pets', tags: ['pets'], responses: { '200': { description: 'OK' } } },
      post: {
        operationId: 'createPet', summary: 'Add a pet', tags: ['pets'],
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' } } } } } },
        responses: { '201': { description: 'Created' } },
      },
    },
    '/pets/{id}': {
      parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
      get:    { operationId: 'getPet', tags: ['pets'], responses: { '200': { description: 'OK' } } },
      delete: { operationId: 'deletePet', tags: ['pets'], responses: { '204': { description: 'No Content' } } },
    },
  },
};

describe('openapi adapter', () => {
  it('parses paths × methods into endpoints', async () => {
    const ir = await openapi.parse({ format: 'openapi3', doc: PETSTORE_MINI });
    expect(ir.protocol).toBe('rest');
    expect(ir.endpoints).toHaveLength(4);
    const listPets = ir.endpoints.find((e) => e.operationId === 'listPets');
    expect(listPets.method).toBe('GET');
    expect(listPets.path).toBe('/pets');
    expect(listPets.tags).toEqual(['pets']);
  });

  it('produces a runnable sampleRequest with {{baseUrl}} and path params', async () => {
    const ir = await openapi.parse({ format: 'openapi3', doc: PETSTORE_MINI });
    const getPet = ir.endpoints.find((e) => e.operationId === 'getPet');
    expect(getPet.sampleRequest.method).toBe('GET');
    expect(getPet.sampleRequest.url).toContain('{{baseUrl}}');
    expect(getPet.sampleRequest.url).toContain('{{id}}');
    expect(getPet.sampleRequest.assertions[0]).toMatchObject({ type: 'status' });
  });

  it('synthesises a body example for POST endpoints with a schema', async () => {
    const ir = await openapi.parse({ format: 'openapi3', doc: PETSTORE_MINI });
    const createPet = ir.endpoints.find((e) => e.operationId === 'createPet');
    expect(createPet.sampleRequest.headers['Content-Type']).toBe('application/json');
    expect(createPet.sampleRequest.body).toBeDefined();
  });
});

// ──────────────────────────── Postman adapter ────────────────────────────

const POSTMAN_MINI = {
  info: { _postman_id: '123', name: 'Demo', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
  item: [
    {
      name: 'Users',
      item: [
        {
          name: 'Get user',
          request: {
            method: 'GET',
            header: [{ key: 'Authorization', value: 'Bearer AKIAIOSFODNN7EXAMPLE' }],
            url: { raw: 'https://api.example.com/users/:id', protocol: 'https', host: ['api','example','com'], path: ['users',':id'], variable: [{ key: 'id', value: '1' }] },
          },
        },
      ],
    },
    {
      name: 'Create',
      request: {
        method: 'POST',
        header: [{ key: 'Content-Type', value: 'application/json' }],
        body:   { mode: 'raw', options: { raw: { language: 'json' } }, raw: '{"name":"alice"}' },
        url:    { raw: 'https://api.example.com/users', protocol: 'https', host: ['api','example','com'], path: ['users'] },
      },
    },
  ],
};

describe('postman adapter', () => {
  it('flattens nested folders into endpoints with folder paths as tags', async () => {
    const ir = await postman.parse({ format: 'postman21', doc: POSTMAN_MINI });
    expect(ir.endpoints).toHaveLength(2);
    const getUser = ir.endpoints.find((e) => e.method === 'GET');
    expect(getUser.tags).toEqual(['Users']);
    expect(getUser.path).toBe('/users/{id}');
  });

  it('scrubs secrets out of headers and surfaces findings', async () => {
    const ir = await postman.parse({ format: 'postman21', doc: POSTMAN_MINI });
    expect(ir.__provenance.secretFindings.length).toBeGreaterThan(0);
    // Authorization header value should be a redaction marker, not the original key.
    const getUser = ir.endpoints.find((e) => e.method === 'GET');
    expect(getUser.sampleRequest.headers.Authorization).not.toContain('AKIA');
  });

  it('parses a raw JSON body into a body example', async () => {
    const ir = await postman.parse({ format: 'postman21', doc: POSTMAN_MINI });
    const create = ir.endpoints.find((e) => e.method === 'POST');
    expect(create.sampleRequest.body).toEqual({ name: 'alice' });
  });
});

// ──────────────────────────── curl adapter ────────────────────────────

describe('curl adapter', () => {
  it('parses a simple GET', async () => {
    const ir = await curl.parse({ raw: 'curl https://api.example.com/users' });
    expect(ir.endpoints).toHaveLength(1);
    expect(ir.endpoints[0].method).toBe('GET');
    expect(ir.endpoints[0].path).toBe('/users');
  });

  it('parses headers and a JSON body, defaulting to POST when -d is used', async () => {
    const cmd = `curl -X POST -H "Content-Type: application/json" -H "X-Auth: t" -d '{"name":"a"}' https://api.example.com/users`;
    const ir = await curl.parse({ raw: cmd });
    const ep = ir.endpoints[0];
    expect(ep.method).toBe('POST');
    expect(ep.sampleRequest.headers['Content-Type']).toBe('application/json');
    expect(ep.sampleRequest.headers['X-Auth']).toBe('t');
    expect(ep.sampleRequest.body).toEqual({ name: 'a' });
  });

  it('handles -u basic auth by writing the Authorization header', async () => {
    const ir = await curl.parse({ raw: 'curl -u admin:hunter2 https://api.example.com/secure' });
    expect(ir.endpoints[0].sampleRequest.headers.Authorization).toMatch(/^Basic /);
  });
});

// ──────────────────────────── fetcher SSRF guards ────────────────────────────

describe('fetcher private-IP detection', () => {
  it('blocks 127.0.0.1, 10.x, 172.16.x, 192.168.x, link-local 169.254.x', () => {
    expect(isPrivateIPv4('127.0.0.1')).toBe(true);
    expect(isPrivateIPv4('10.1.2.3')).toBe(true);
    expect(isPrivateIPv4('172.16.0.1')).toBe(true);
    expect(isPrivateIPv4('192.168.1.1')).toBe(true);
    expect(isPrivateIPv4('169.254.169.254')).toBe(true); // AWS/Azure IMDS
  });
  it('allows public IPs', () => {
    expect(isPrivateIPv4('8.8.8.8')).toBe(false);
    expect(isPrivateIPv4('1.1.1.1')).toBe(false);
  });
});
