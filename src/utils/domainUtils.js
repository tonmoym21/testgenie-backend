/**
 * Public-suffix-aware host → registrable-domain helper.
 *
 * Why: cookie scoping for body-cookies needs to know the right `Domain=`
 * attribute so sibling subdomains receive the cookie. A naive
 * "drop the first label" rule is wrong for two-label TLDs — `api.foo.co.uk`
 * would yield `foo.co.uk` correctly with drop-first, but the inverse case
 * `foo.co.uk` (already at eTLD+1) would incorrectly back off to `co.uk`,
 * a public suffix that no one can own. The list below covers the multi-part
 * suffixes seen in real-world traffic; everything else falls through to
 * "last two labels," which is correct for `.com`, `.io`, `.dev`, etc.
 *
 * Not exhaustive — Mozilla's full Public Suffix List has thousands of
 * entries. If a domain reports an issue, add its suffix to the set.
 */

// Two-label public suffixes. Hostnames whose last two labels match one of
// these need three labels to reach the registrable domain.
const MULTI_PART_TLDS = new Set([
  // United Kingdom
  'co.uk', 'ac.uk', 'gov.uk', 'org.uk', 'me.uk', 'net.uk', 'plc.uk', 'sch.uk', 'ltd.uk', 'nhs.uk',
  // Australia
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'asn.au',
  // Japan
  'co.jp', 'ac.jp', 'ne.jp', 'or.jp', 'go.jp', 'ad.jp', 'gr.jp', 'lg.jp', 'ed.jp',
  // Brazil
  'com.br', 'gov.br', 'edu.br', 'org.br', 'net.br', 'mil.br',
  // India
  'co.in', 'net.in', 'org.in', 'edu.in', 'gov.in', 'ac.in', 'gen.in', 'firm.in', 'ind.in', 'res.in',
  // Mexico
  'com.mx', 'gob.mx', 'edu.mx', 'org.mx', 'net.mx',
  // South Africa
  'co.za', 'gov.za', 'org.za', 'edu.za', 'ac.za', 'net.za', 'web.za',
  // Singapore
  'com.sg', 'edu.sg', 'gov.sg', 'org.sg', 'net.sg', 'per.sg',
  // South Korea
  'co.kr', 'or.kr', 'ne.kr', 'go.kr', 'ac.kr', 'pe.kr', 'kg.kr', 're.kr',
  // New Zealand
  'co.nz', 'ac.nz', 'org.nz', 'net.nz', 'gen.nz', 'school.nz', 'govt.nz',
  // Hong Kong
  'com.hk', 'edu.hk', 'gov.hk', 'org.hk', 'net.hk', 'idv.hk',
  // Taiwan
  'com.tw', 'edu.tw', 'gov.tw', 'org.tw', 'net.tw', 'idv.tw',
  // China
  'com.cn', 'edu.cn', 'gov.cn', 'net.cn', 'org.cn', 'ac.cn', 'mil.cn',
  // Turkey
  'com.tr', 'edu.tr', 'gov.tr', 'org.tr', 'net.tr', 'bel.tr', 'web.tr',
  // Indonesia
  'co.id', 'or.id', 'go.id', 'ac.id', 'sch.id', 'web.id', 'mil.id', 'biz.id',
  // Argentina
  'com.ar', 'gov.ar', 'edu.ar', 'org.ar', 'net.ar', 'gob.ar',
  // Colombia
  'com.co', 'edu.co', 'gov.co', 'org.co', 'net.co', 'mil.co',
  // Vietnam
  'com.vn', 'edu.vn', 'gov.vn', 'org.vn', 'net.vn', 'biz.vn',
  // Malaysia
  'com.my', 'edu.my', 'gov.my', 'org.my', 'net.my', 'mil.my',
  // Philippines
  'com.ph', 'edu.ph', 'gov.ph', 'org.ph', 'net.ph',
  // Peru
  'com.pe', 'edu.pe', 'gob.pe', 'org.pe', 'net.pe',
  // Ecuador
  'com.ec', 'gov.ec', 'edu.ec', 'org.ec', 'net.ec',
  // Israel
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il', 'k12.il',
  // Other commonly-seen
  'com.eg', 'com.gh', 'com.kw', 'com.lb', 'com.ng', 'com.pk', 'com.qa',
  'com.sa', 'com.ua', 'com.uy', 'com.ve', 'com.hr', 'com.bd', 'com.bh',
  'com.bo', 'com.do', 'com.ec', 'com.fj', 'com.gt', 'com.hn', 'com.jo',
  'com.ly', 'com.mt', 'com.na', 'com.ni', 'com.np', 'com.pa', 'com.py',
  'com.sv',
  // Thailand
  'co.th', 'ac.th', 'or.th', 'go.th', 'in.th', 'mi.th', 'net.th',
  // Kenya
  'co.ke', 'or.ke', 'ne.ke', 'go.ke', 'ac.ke', 'me.ke', 'sc.ke',
]);

function isIpAddress(host) {
  // Bracketed IPv6 strips the brackets when URL.hostname is read; bare
  // IPv6 strings still contain `:`. IPv4 is all-digits-and-dots.
  return /^[\d.]+$/.test(host) || host.includes(':');
}

/**
 * Return the registrable domain of a URL — i.e. the eTLD+1 — or null when
 * the URL is malformed, an IP, or the hostname is already a public suffix.
 *
 *   eauth.engagedly.com    → engagedly.com
 *   engagedly.com          → engagedly.com
 *   api.foo.co.uk          → foo.co.uk
 *   foo.co.uk              → foo.co.uk
 *   localhost              → null
 *   192.168.1.1            → null
 */
function getRegistrableDomain(urlString) {
  if (!urlString) return null;
  let host;
  try { host = new URL(urlString).hostname; }
  catch { return null; }
  if (!host || isIpAddress(host)) return null;

  const parts = host.split('.');
  if (parts.length < 2) return null;

  // If the last two labels form a known multi-part suffix (e.g. co.uk),
  // the registrable domain needs three labels. Otherwise, two is enough.
  if (parts.length >= 3) {
    const lastTwo = parts.slice(-2).join('.');
    if (MULTI_PART_TLDS.has(lastTwo)) {
      return parts.slice(-3).join('.');
    }
  }
  return parts.slice(-2).join('.');
}

module.exports = { getRegistrableDomain };
