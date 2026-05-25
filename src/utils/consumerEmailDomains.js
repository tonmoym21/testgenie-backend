// Consumer / free / disposable email providers. Any address whose domain
// matches this set is treated as a *personal* email — blocked from
// creating new TestForge organizations (the SaaS tenancy model is keyed
// on corporate domain ownership).
//
// Existing users on consumer domains keep working. Only new-org creation
// is gated. Platform admins can manually create users/orgs on any
// domain via the admin console (covers the rare legitimate exception).
//
// The list intentionally errs on the side of false positives — a real
// company using @gmail.com for its team would be misclassified, but
// that's vanishingly rare in our target market and the admin override
// covers it. Easier to relax than tighten later.
//
// Update path: append to CONSUMER_DOMAINS (alphabetical please). No
// migration needed.

const CONSUMER_DOMAINS = new Set([
  // Major free webmail (global)
  'aol.com',
  'gmail.com',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'hotmail.co.uk',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'mac.com',
  'mail.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'protonmail.com',
  'proton.me',
  'pm.me',
  'tutanota.com',
  'yahoo.co.in',
  'yahoo.co.jp',
  'yahoo.co.uk',
  'yahoo.com',
  'yahoo.fr',
  'yandex.com',
  'yandex.ru',
  'zoho.com',

  // India-specific (TestForge is currently India-heavy via Engagedly)
  'rediffmail.com',

  // Common disposable / temp-mail providers — anyone using these for
  // an "org signup" is testing or abusing. Block.
  '10minutemail.com',
  'guerrillamail.com',
  'mailinator.com',
  'sharklasers.com',
  'temp-mail.org',
  'tempmail.com',
  'throwawaymail.com',
  'trashmail.com',
  'yopmail.com',
]);

function getDomain(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase().trim();
}

/**
 * True if the email's domain is on the consumer/free/disposable list.
 * Falsy inputs (no email, malformed) return false — let validation
 * surface "invalid email" upstream, don't conflate it with "blocked".
 */
function isConsumerEmail(email) {
  const domain = getDomain(email);
  return domain != null && CONSUMER_DOMAINS.has(domain);
}

module.exports = { isConsumerEmail, getDomain, CONSUMER_DOMAINS };
