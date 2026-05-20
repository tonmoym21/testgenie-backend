// curl-paste adapter.
//
// Users at 11pm have a curl command from devtools and don't want to learn
// OpenAPI. We tokenise the command, pull out method/url/headers/body, and
// produce a single-endpoint NormalizedSource. Scope is intentionally narrow:
// the common `curl -X POST -H ... -d ...` shape covers ~95% of real pastes.
// Unsupported flags (cookies, file uploads, --data-urlencode) are ignored
// rather than producing wrong output.

const FORMAT = 'curl';

function detect(input) {
  if (input.format === 'curl') return { confidence: 0.95, format: 'curl' };
  return null;
}

// Tokenise honouring single/double quotes and backslash line-continuations.
function tokenize(cmd) {
  const tokens = [];
  let cur = '';
  let quote = null;
  let i = 0;
  const s = cmd.replace(/\\\s*\n\s*/g, ' ').trim();

  while (i < s.length) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) { quote = null; i += 1; continue; }
      if (ch === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 2; continue; }
      cur += ch; i += 1; continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; i += 1; continue; }
    if (ch === '\\' && i + 1 < s.length) { cur += s[i + 1]; i += 2; continue; }
    if (/\s/.test(ch)) {
      if (cur) { tokens.push(cur); cur = ''; }
      i += 1; continue;
    }
    cur += ch; i += 1;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function parse(input) {
  const cmd = (input.raw || '').trim();
  if (!/^curl\b/.test(cmd)) throw new Error('Curl adapter: input is not a curl command');

  const tokens = tokenize(cmd).slice(1); // drop the leading `curl`

  let method = null;
  let url = null;
  const headers = {};
  let body;
  let bodyType = 'application/json';

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    switch (t) {
      case '-X':
      case '--request':
        method = tokens[++i]; break;
      case '-H':
      case '--header': {
        const h = tokens[++i] || '';
        const idx = h.indexOf(':');
        if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
        break;
      }
      case '-d':
      case '--data':
      case '--data-raw':
      case '--data-binary': {
        const raw = tokens[++i];
        try { body = JSON.parse(raw); }
        catch { body = raw; bodyType = 'text/plain'; }
        if (!method) method = 'POST';
        break;
      }
      case '--data-urlencode': {
        i++; // skip value, urlencoded forms are out of scope for v1
        if (!method) method = 'POST';
        bodyType = 'application/x-www-form-urlencoded';
        break;
      }
      case '-u':
      case '--user': {
        const creds = tokens[++i] || '';
        headers['Authorization'] = `Basic ${Buffer.from(creds).toString('base64')}`;
        break;
      }
      case '-G':
      case '--get':
        method = 'GET'; break;
      case '-I':
      case '--head':
        method = 'HEAD'; break;
      case '-k':
      case '--insecure':
      case '-L':
      case '--location':
      case '-s':
      case '--silent':
      case '-v':
      case '--verbose':
      case '-i':
      case '--include':
      case '--compressed':
        // No-op for our purposes.
        break;
      // Known single-value flags that take an argument we don't care about
      // semantically. Listing them keeps the URL scan from accidentally
      // eating the URL when an unknown flag's value happens to look like one.
      case '-A':
      case '--user-agent':
      case '-e':
      case '--referer':
      case '--connect-timeout':
      case '--max-time':
      case '-o':
      case '--output':
      case '-w':
      case '--write-out':
      case '-x':
      case '--proxy':
      case '--resolve':
      case '--cookie':
      case '-b':
      case '--cookie-jar':
      case '-c':
        i++; // consume the flag's value
        break;
      default:
        // First non-flag token that looks like a URL → that's our target.
        if (!url && /^https?:\/\//.test(t)) url = t;
        // Unknown flag — DON'T skip the next token, otherwise something like
        // `--unknown-flag https://api.example.com` would lose the URL. If a
        // future curl flag does take an argument and we miss it, we'll over-
        // parse rather than under-parse, which is the safer failure mode.
    }
  }

  if (!url) throw new Error('Curl adapter: no URL found in command');
  method = (method || 'GET').toUpperCase();

  // Pull out path + server from the URL so the catalog has a sensible row.
  let path = url;
  let server;
  try {
    const u = new URL(url);
    server = `${u.protocol}//${u.host}`;
    path = u.pathname + (u.search || '');
  } catch { /* keep as-is */ }

  if (body !== undefined && !headers['Content-Type']) headers['Content-Type'] = bodyType;

  const endpoint = {
    protocol: 'rest',
    operationId: undefined,
    method,
    path,
    summary: `${method} ${path}`,
    description: 'Imported from curl',
    tags: ['curl'],
    authRequirement: headers['Authorization'] ? [{ type: 'inline', source: 'curl' }] : [],
    requestSchema: { parameters: [], body: body !== undefined ? { contentType: headers['Content-Type'], example: body } : undefined },
    responseSchema: { byStatus: {} },
    sampleRequest: {
      method,
      url,
      headers,
      body,
      assertions: [{ type: 'status', operator: 'lt', value: 400 }],
      extractors: [],
      timeout: 10000,
    },
    examples: [],
  };

  return Promise.resolve({
    name: `curl ${method} ${path}`.slice(0, 200),
    protocol: 'rest',
    format: 'curl',
    servers: server ? [{ url: server }] : [],
    authSchemes: [],
    endpoints: [endpoint],
  });
}

module.exports = { FORMAT, detect, parse };
