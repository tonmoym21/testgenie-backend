/**
 * Thin wrapper around tough-cookie that gives the collection runner a
 * per-run cookie jar. Spec-compliant Domain/Path/Expires/Max-Age/Secure
 * handling, isolated by call (no module-level state).
 */
const { CookieJar, Cookie } = require('tough-cookie');

function createJar() {
  // looseMode: tolerate cookies without explicit Domain (the common case
  // for APIs that set cookies on the origin host).
  return new CookieJar(null, { looseMode: true });
}

/**
 * Ingest an array of raw Set-Cookie header strings observed at `urlString`.
 * Silently skips malformed cookies — we never want a bad cookie to fail a run.
 */
async function ingestSetCookies(jar, urlString, setCookieRawArray) {
  if (!jar || !urlString || !Array.isArray(setCookieRawArray)) return;
  for (const raw of setCookieRawArray) {
    try {
      const cookie = Cookie.parse(raw);
      if (cookie) await jar.setCookie(cookie, urlString, { ignoreError: true });
    } catch {
      // ignore — bad Set-Cookie strings should not abort the chain
    }
  }
}

/**
 * Build the Cookie request header value for `urlString` from the jar.
 * Returns empty string if no cookies apply. Honors Path / Domain / Secure /
 * Expires via tough-cookie's matching rules.
 */
async function cookieHeaderFor(jar, urlString) {
  if (!jar || !urlString) return '';
  try {
    return await jar.getCookieString(urlString);
  } catch {
    return '';
  }
}

/**
 * Return a serialisable snapshot of every cookie currently in the jar.
 * Used by the UI to display chain state per step.
 */
async function snapshot(jar) {
  if (!jar) return [];
  try {
    const all = await jar.getCookies('http://_/'); // ignored — we serialize the store directly below
    // Prefer the full store contents: getCookies(url) only returns cookies matching that url.
    // Use the internal store iterator instead.
    return await new Promise((resolve) => {
      const out = [];
      jar.store.getAllCookies((err, cookies) => {
        if (err || !cookies) return resolve(out);
        for (const c of cookies) {
          out.push({
            name: c.key,
            value: c.value,
            domain: c.domain || null,
            path: c.path || '/',
            expires: c.expires && c.expires !== 'Infinity' ? new Date(c.expires).toISOString() : null,
            secure: !!c.secure,
            httpOnly: !!c.httpOnly,
            sameSite: c.sameSite || null,
          });
        }
        resolve(out);
      });
      // suppress unused-var lint
      void all;
    });
  } catch {
    return [];
  }
}

module.exports = { createJar, ingestSetCookies, cookieHeaderFor, snapshot };
