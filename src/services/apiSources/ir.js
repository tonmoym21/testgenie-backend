// The Normalized Operation IR.
//
// Every adapter (OpenAPI, Postman, curl, URL-probe, future GraphQL/gRPC) is
// required to flatten its input into this shape. Downstream code — catalog
// queries, the executor handoff that builds test_definitions, the diff
// engine — only knows about the IR, never about wire formats. Adding a new
// source type later means writing one adapter that emits IR; no changes to
// any consumer.

/**
 * @typedef {Object} NormalizedSource
 * @property {string} name
 * @property {'rest'|'graphql'|'grpc'|'asyncapi'} protocol
 * @property {string} format                       e.g. 'openapi3'
 * @property {string} [specVersion]
 * @property {string} [sourceUrl]
 * @property {Array<{url:string, description?:string, variables?:object}>} servers
 * @property {Array<{name:string, type:string, scheme?:string, in?:string, [k:string]:any}>} authSchemes
 * @property {NormalizedEndpoint[]} endpoints
 */

/**
 * @typedef {Object} NormalizedEndpoint
 * @property {'rest'|'graphql'|'grpc'|'asyncapi'} protocol
 * @property {string} [operationId]
 * @property {string} method                       UPPERCASE; for non-REST use 'POST' as sensible default
 * @property {string} path                          /users/{id}
 * @property {string} [summary]
 * @property {string} [description]
 * @property {string[]} tags
 * @property {Array<{type:string, name?:string, scheme?:string}>} authRequirement
 * @property {RequestSchema} requestSchema
 * @property {ResponseSchema} responseSchema
 * @property {SampleRequest} sampleRequest         ready-to-execute request shape
 * @property {object} [bindings]                    e.g. per-endpoint server override
 * @property {Array<object>} examples
 * @property {object} [vendorExtensions]
 * @property {boolean} [deprecated]
 */

/**
 * @typedef {Object} RequestSchema
 * @property {Array<{name:string, in:'path'|'query'|'header'|'cookie', required?:boolean, schema?:object, example?:any}>} parameters
 * @property {{contentType?:string, schema?:object, example?:any}} [body]
 */

/**
 * @typedef {Object} ResponseSchema
 * @property {Object.<string,{description?:string, contentType?:string, schema?:object, example?:any}>} byStatus
 */

/**
 * @typedef {Object} SampleRequest
 * @property {string} method
 * @property {string} url               with {{baseUrl}} or absolute, ready for env substitution
 * @property {Object.<string,string>} headers
 * @property {any} [body]
 * @property {Array<object>} assertions
 * @property {Array<object>} extractors
 * @property {number} [timeout]
 */

function emptyResponseSchema() { return { byStatus: {} }; }
function emptyRequestSchema()  { return { parameters: [] }; }
function emptySampleRequest()  { return { method: 'GET', url: '', headers: {}, assertions: [], extractors: [], timeout: 10000 }; }

// Best-effort: turn an OpenAPI path template into an executable URL using
// `{{baseUrl}}`. Path params are left as `{{paramName}}` so they bind to
// TestForge environment variables when the test runs.
function buildSampleUrl(server, path, pathParams = []) {
  const base = server ? '{{baseUrl}}' : '{{baseUrl}}';
  let url = `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  for (const p of pathParams) {
    url = url.replace(new RegExp(`\\{${p.name}\\}`, 'g'), `{{${p.name}}}`);
  }
  return url;
}

module.exports = {
  emptyResponseSchema,
  emptyRequestSchema,
  emptySampleRequest,
  buildSampleUrl,
};
