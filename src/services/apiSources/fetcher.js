const dns = require('dns').promises;
const net = require('net');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const logger = require('../../utils/logger');

// SSRF-safe fetch for API specs. The user can paste any URL — without this
// guard, a paste of http://169.254.169.254/latest/meta-data/ would gleefully
// fetch our cloud instance metadata. The defences here are layered:
//
//   1. Scheme allow-list (https + http only)
//   2. DNS resolved manually; private/loopback/link-local/metadata ranges blocked
//   3. The resolved IP is passed to the connect() call directly to defeat
//      DNS rebinding (attacker flips A record between our resolve and connect)
//   4. Redirects are followed at most MAX_REDIRECTS times, each one re-validated
//   5. Hard cap on response size and request time
//
// Returns { body: Buffer, contentType, status, finalUrl, sizeBytes }.

const MAX_REDIRECTS = 3;
const MAX_SIZE = 10 * 1024 * 1024; // 10 MB
const REQUEST_TIMEOUT_MS = 15000;

const PRIVATE_V4 = [
  ['10.0.0.0', 8],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],     // link-local, includes AWS/Azure IMDS
  ['100.64.0.0', 10],      // CGNAT
  ['0.0.0.0', 8],
  ['192.0.2.0', 24],       // TEST-NET-1
  ['198.18.0.0', 15],      // benchmarking
  ['198.51.100.0', 24],    // TEST-NET-2
  ['203.0.113.0', 24],     // TEST-NET-3
  ['224.0.0.0', 4],        // multicast
  ['240.0.0.0', 4],        // reserved
];

function ipToInt(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function isPrivateIPv4(ip) {
  const num = ipToInt(ip);
  return PRIVATE_V4.some(([base, bits]) => {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return (num & mask) === (ipToInt(base) & mask);
  });
}

function isPrivateIPv6(ip) {
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return true;
  // ULA fc00::/7, link-local fe80::/10.
  if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return true;

  // IPv4-mapped addresses can be written two ways:
  //   ::ffff:127.0.0.1   (dotted)   ← old check only caught this
  //   ::ffff:7f00:0001   (hex form) ← previously bypassed → SSRF
  // Both shapes must be detected and the embedded v4 re-checked.
  const dotted = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return isPrivateIPv4(dotted[1]);
  const hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low  = parseInt(hex[2], 16);
    const v4 = `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
    return isPrivateIPv4(v4);
  }
  return false;
}

function isBlockedHost(hostname) {
  // Reject hostname-form references to known metadata services even before
  // DNS — saves a roundtrip and catches typo'd hostnames pointing at IMDS.
  const lower = hostname.toLowerCase();
  return (
    lower === 'metadata.google.internal' ||
    lower === 'metadata' ||
    lower.endsWith('.internal') ||
    lower === 'localhost'
  );
}

async function resolveSafely(hostname) {
  // If user literally pasted an IP, validate that. Otherwise resolve and
  // pick a public address.
  if (net.isIP(hostname)) {
    const ip = hostname;
    const blocked = net.isIPv4(ip) ? isPrivateIPv4(ip) : isPrivateIPv6(ip);
    if (blocked) throw new Error(`Blocked private/reserved address: ${ip}`);
    return { ip, family: net.isIPv4(ip) ? 4 : 6 };
  }
  if (isBlockedHost(hostname)) throw new Error(`Blocked hostname: ${hostname}`);

  const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  for (const { address, family } of addresses) {
    const blocked = family === 4 ? isPrivateIPv4(address) : isPrivateIPv6(address);
    if (!blocked) return { ip: address, family };
  }
  throw new Error(`No public address resolves for ${hostname}`);
}

function fetchOne(targetUrl, allowHttp) {
  return new Promise(async (resolve, reject) => {
    let parsed;
    try { parsed = new URL(targetUrl); } catch { return reject(new Error('Invalid URL')); }

    if (!/^https?:$/.test(parsed.protocol)) {
      return reject(new Error(`Blocked scheme: ${parsed.protocol}`));
    }
    if (parsed.protocol === 'http:' && !allowHttp) {
      return reject(new Error('HTTP not allowed; use HTTPS'));
    }

    let resolved;
    try { resolved = await resolveSafely(parsed.hostname); }
    catch (err) { return reject(err); }

    // Pin the resolved IP for the connection but keep the original Host header
    // so TLS SNI / virtual hosts still work. The custom `lookup` is what
    // closes the DNS-rebinding hole — the agent can't re-resolve mid-flight.
    const lib = parsed.protocol === 'https:' ? https : http;
    const req = lib.request({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        'User-Agent': 'TestForge-ApiImport/1.0',
        'Accept': 'application/json, application/yaml, text/yaml, text/plain, */*',
      },
      lookup: (_host, _opts, cb) => cb(null, resolved.ip, resolved.family),
      timeout: REQUEST_TIMEOUT_MS,
    });

    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.on('response', (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        return resolve({ redirect: new URL(res.headers.location, targetUrl).toString(), status });
      }

      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_SIZE) {
          req.destroy(new Error(`Response exceeded ${MAX_SIZE} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({
          body: Buffer.concat(chunks),
          contentType: res.headers['content-type'] || '',
          status,
          finalUrl: targetUrl,
          sizeBytes: size,
        });
      });
      res.on('error', reject);
    });
    req.end();
  });
}

async function fetchSpec(url, opts = {}) {
  const allowHttp = !!opts.allowHttp;
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    // Each hop is re-validated — a malicious server can't redirect us into
    // a private range mid-chain.
    const res = await fetchOne(current, allowHttp);
    if (res.redirect) {
      logger.debug({ from: current, to: res.redirect }, 'apiSource fetcher: following redirect');
      current = res.redirect;
      continue;
    }
    return res;
  }
  throw new Error('Too many redirects');
}

module.exports = { fetchSpec, isPrivateIPv4, isPrivateIPv6, MAX_SIZE };
