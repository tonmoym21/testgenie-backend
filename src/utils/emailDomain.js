const PUBLIC_EMAIL_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in',
  'outlook.com', 'hotmail.com', 'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'proton.me', 'protonmail.com', 'yandex.com', 'yandex.ru',
  'zoho.com', 'mail.com', 'gmx.com', 'gmx.de', 'live.com', 'msn.com',
]);

function getEmailDomain(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase().trim();
}

function isCorporateDomain(email) {
  const d = getEmailDomain(email);
  if (!d) return false;
  return !PUBLIC_EMAIL_PROVIDERS.has(d);
}

module.exports = { getEmailDomain, isCorporateDomain, PUBLIC_EMAIL_PROVIDERS };
