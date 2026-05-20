// Auto-detect input format from the raw paste. The user shouldn't have to
// choose "OpenAPI" vs "Postman" vs "curl" — content signatures are reliable.
//
// Returns { format, confidence, hint } or null if unrecognised.
// format ∈ openapi3 | openapi2 | postman21 | curl | url_probe | json_unknown

const yaml = require('js-yaml');

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
function safeYaml(s) {
  try { return yaml.load(s, { schema: yaml.FAILSAFE_SCHEMA, json: false }); }
  catch { return null; }
}

function detectFromText(raw) {
  if (!raw || typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Bare URL → URL probe (we'll try common spec paths)
  if (/^https?:\/\/\S+$/i.test(trimmed) && !trimmed.includes('\n')) {
    return { format: 'url_probe', confidence: 0.9, hint: 'URL — will probe for spec endpoints' };
  }

  // curl command
  if (/^\s*curl\s/i.test(trimmed)) {
    return { format: 'curl', confidence: 0.95, hint: 'curl command' };
  }

  // Try JSON first (cheaper, stricter), then YAML
  const doc = safeJson(trimmed) || safeYaml(trimmed);
  if (!doc || typeof doc !== 'object') {
    // Probably a YAML/JSON we couldn't parse — surface as unknown so caller
    // returns a useful error rather than crashing inside an adapter.
    return null;
  }

  // OpenAPI 3.x — `openapi` field starting with "3."
  if (typeof doc.openapi === 'string' && /^3\./.test(doc.openapi)) {
    return { format: 'openapi3', confidence: 0.99, hint: `OpenAPI ${doc.openapi}`, doc };
  }

  // Swagger 2.0
  if (doc.swagger === '2.0' || doc.swagger === 2 || doc.swagger === '2') {
    return { format: 'openapi2', confidence: 0.99, hint: 'Swagger 2.0', doc };
  }

  // Postman Collection v2.1 (or v2.0). The `_postman_id` field is the most
  // reliable signal; `info.schema` carries the version URL.
  if (doc.info && (doc.info._postman_id || /postman.com\/.*collection/.test(doc.info.schema || ''))) {
    return { format: 'postman21', confidence: 0.99, hint: 'Postman Collection', doc };
  }

  return { format: 'json_unknown', confidence: 0.3, hint: 'JSON document — format not recognised', doc };
}

module.exports = { detectFromText };
