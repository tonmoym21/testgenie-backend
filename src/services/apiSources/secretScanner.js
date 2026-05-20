// Postman collections often ship with baked-in credentials — a Bearer token
// in a header, an API key in a query param, basic-auth password in a body.
// Importing those verbatim would persist live secrets into our DB and leak
// them on every export. We scan during ingest and strip into placeholders;
// the caller can then surface a "secrets detected" banner to the user.
//
// Scope: heuristic, not bulletproof. Catches the common, high-confidence
// shapes (bearer/api-key/aws/github/stripe/openai) and high-entropy strings
// in known sensitive fields. Cleared during the audit log review.

const HIGH_CONFIDENCE_PATTERNS = [
  { name: 'aws_access_key_id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'github_pat',        re: /\bghp_[A-Za-z0-9]{36,}\b/g },
  { name: 'github_pat_fine',   re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { name: 'stripe_live',       re: /\bsk_live_[A-Za-z0-9]{20,}\b/g },
  { name: 'stripe_restricted', re: /\brk_live_[A-Za-z0-9]{20,}\b/g },
  { name: 'openai',            re: /\bsk-[A-Za-z0-9]{32,}\b/g },
  { name: 'slack_token',       re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { name: 'google_api_key',    re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { name: 'jwt',               re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
];

// Field names that strongly imply the value is sensitive.
const SENSITIVE_FIELD_NAMES = new Set([
  'authorization', 'auth', 'token', 'access_token', 'access-token', 'bearer',
  'x-api-key', 'api-key', 'apikey', 'api_key',
  'password', 'pass', 'secret', 'client_secret', 'private_key', 'privatekey',
  'cookie', 'set-cookie',
]);

function isSensitiveFieldName(name) {
  if (!name) return false;
  return SENSITIVE_FIELD_NAMES.has(String(name).toLowerCase().trim());
}

// Shannon entropy in bits/char — values above ~4.0 over a sufficiently long
// string are likely credentials, not prose.
function entropy(str) {
  if (!str || str.length < 20) return 0;
  const freq = {};
  for (const ch of str) freq[ch] = (freq[ch] || 0) + 1;
  let h = 0;
  for (const c of Object.values(freq)) {
    const p = c / str.length;
    h -= p * Math.log2(p);
  }
  return h;
}

function findInString(value, fieldHint) {
  const hits = [];
  if (typeof value !== 'string' || !value) return hits;

  for (const { name, re } of HIGH_CONFIDENCE_PATTERNS) {
    re.lastIndex = 0;
    if (re.test(value)) hits.push({ kind: name, fieldHint });
  }

  // Field-name signal + high entropy → likely credential even without a
  // recognisable prefix. Skips template placeholders (`{{x}}`).
  if (
    isSensitiveFieldName(fieldHint) &&
    value.length >= 16 &&
    !/^\{\{.*\}\}$/.test(value.trim()) &&
    entropy(value) >= 3.8
  ) {
    hits.push({ kind: 'sensitive_field_high_entropy', fieldHint });
  }

  return hits;
}

// Walk a Postman v2.1 collection (or any JSON object) and replace detected
// secrets in-place with `{{secret:<n>}}` markers. Returns the redacted clone
// plus the list of findings. Original object is not mutated.
function scanAndRedact(input) {
  if (input == null) return { redacted: input, findings: [] };
  const findings = [];
  let counter = 0;

  function recurse(node, fieldHint) {
    if (Array.isArray(node)) return node.map((v) => recurse(v, fieldHint));
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        // For Postman header/query objects ({ key, value }), the `key`
        // value is the actual field name — surface it as the hint for `value`.
        const childHint = (k === 'value' && typeof node.key === 'string') ? node.key : k;
        out[k] = recurse(v, childHint);
      }
      return out;
    }
    if (typeof node === 'string') {
      const hits = findInString(node, fieldHint);
      if (hits.length) {
        counter += 1;
        const id = `secret:${counter}`;
        findings.push({ id, field: fieldHint, kinds: hits.map((h) => h.kind) });
        return `{{${id}}}`;
      }
    }
    return node;
  }

  const redacted = recurse(input, null);
  return { redacted, findings };
}

module.exports = { scanAndRedact, findInString, isSensitiveFieldName };
