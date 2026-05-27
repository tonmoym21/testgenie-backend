const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const { ConflictError, UnauthorizedError, ForbiddenError, NotFoundError, ApiError } = require('../utils/apiError');
const teamService = require('./teamService');
const { isCorporateDomain, getEmailDomain } = require('../utils/emailDomain');
const { isConsumerEmail } = require('../utils/consumerEmailDomains');
const transactionalEmail = require('./transactionalEmail');
const logger = require('../utils/logger');

const BCRYPT_ROUNDS = 12;
const VERIFICATION_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const RESEND_MIN_INTERVAL_MS = 60 * 1000; // throttle resend to 1/min/user

/**
 * Register a new user. Public multi-tenant signup flow:
 *
 *   1. No org exists yet  → first-user bootstrap; user becomes owner,
 *                           email is auto-verified (no email to send yet).
 *   2. Corporate email + domain matches an existing verified org
 *                         → auto-join as member, email auto-verified
 *                           (the existing org's trust covers the new user).
 *   3. Corporate email + no matching org + companyName provided
 *                         → create pending user + pending org, send
 *                           verification email. User must click link
 *                           before login works. Domain is NOT claimed
 *                           until verification completes (race-safe).
 *   4. Consumer email (gmail, outlook, etc.)
 *                         → reject. Personal accounts can't create orgs.
 *                           Platform admins can manually create such
 *                           users via the admin console for exceptions.
 *
 * Returns one of:
 *   { kind: 'autoJoined',  user }             — case 1 & 2: immediate access
 *   { kind: 'pending',     user, email }      — case 3: must verify
 *   throws on rejection
 */
async function register(email, password, companyName) {
  email = email.toLowerCase().trim();
  companyName = (companyName || '').trim();

  const existing = await db.query(
    'SELECT id, email_verified_at FROM users WHERE email = $1',
    [email]
  );
  if (existing.rows.length > 0) {
    // Distinct message for the "started signup but never verified" case
    // so the UI can offer "resend verification" instead of "log in".
    if (existing.rows[0].email_verified_at == null) {
      throw new ConflictError('A signup is already in progress for this email. Check your inbox or request a new verification link.');
    }
    throw new ConflictError('Email already registered');
  }

  const orgCheck = await db.query('SELECT COUNT(*)::int AS count FROM organizations');
  const orgExists = orgCheck.rows[0].count > 0;

  // Case 1: first user ever — bootstrap path (no email-verify gate since
  // there's no inbox infrastructure to depend on at this point).
  if (!orgExists) {
    return _registerFirstUser({ email, password, companyName });
  }

  // Corporate vs consumer split governs everything else.
  if (isConsumerEmail(email) || !isCorporateDomain(email)) {
    throw new ForbiddenError('Please sign up with your work email. Personal email addresses (gmail.com, outlook.com, etc.) can\'t create new organizations on TestForge. Contact support if you need an exception.');
  }

  const domain = getEmailDomain(email);

  // Case 2: domain matches an existing VERIFIED org → auto-join.
  // Pending orgs don't count (their domain isn't claimed yet — see the
  // unique partial index from migration 020).
  const verifiedOrg = await db.query(
    `SELECT o.id FROM organizations o
      WHERE LOWER(o.domain) = $1
        AND o.verified_at IS NOT NULL
        AND o.status = 'active'
      LIMIT 1`,
    [domain]
  );
  if (verifiedOrg.rows.length > 0) {
    return _registerAutoJoin({
      email, password,
      orgId: verifiedOrg.rows[0].id,
      domain,
    });
  }

  // Case 3: net-new corporate domain → pending org + verification email.
  if (!companyName) {
    // ApiError direct (not ValidationError) because ValidationError's
    // constructor swallows the first arg into `details` and hardcodes
    // the user-facing message to "Validation failed" — we want the
    // specific reason on the wire so the UI can show it as-is.
    throw new ApiError(400, 'VALIDATION_ERROR', 'Company name is required to create a new organization.');
  }
  if (companyName.length < 2 || companyName.length > 100) {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Company name must be between 2 and 100 characters.');
  }

  return _registerPending({ email, password, companyName, domain });
}

// ── Internal register helpers — keep register() readable ──────────────

async function _registerFirstUser({ email, password, companyName }) {
  const orgName = companyName || 'TestForge';
  const domain = isCorporateDomain(email) ? getEmailDomain(email) : null;
  const newOrg = await db.query(
    `INSERT INTO organizations (name, domain, domain_restriction_enabled, created_via, verified_at)
     VALUES ($1, $2, true, 'first_user', NOW())
     RETURNING id`,
    [orgName, domain]
  );
  const orgId = newOrg.rows[0].id;

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const result = await db.query(
    `INSERT INTO users (email, password_hash, organization_id, status, email_verified_at)
     VALUES ($1, $2, $3, 'active', NOW())
     RETURNING id, email, organization_id, created_at`,
    [email, passwordHash, orgId]
  );
  const user = result.rows[0];

  await db.query(
    `INSERT INTO organization_members (organization_id, user_id, role)
     VALUES ($1, $2, 'owner')`,
    [orgId, user.id]
  );
  await teamService.logAuditEvent(
    orgId, user.id, 'organization_created', 'user', user.id,
    { email, role: 'owner', isFirstUser: true }
  );
  return { kind: 'autoJoined', user };
}

async function _registerAutoJoin({ email, password, orgId, domain }) {
  // Backfill the domain on the org if it wasn't already recorded (legacy
  // orgs created before the domain field was used).
  await db.query(
    `UPDATE organizations SET domain = $1
       WHERE id = $2 AND (domain IS NULL OR domain = '')`,
    [domain, orgId]
  );

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const result = await db.query(
    `INSERT INTO users (email, password_hash, organization_id, status, email_verified_at)
     VALUES ($1, $2, $3, 'active', NOW())
     RETURNING id, email, organization_id, created_at`,
    [email, passwordHash, orgId]
  );
  const user = result.rows[0];

  await db.query(
    `INSERT INTO organization_members (organization_id, user_id, role)
     VALUES ($1, $2, 'member')`,
    [orgId, user.id]
  );
  await teamService.logAuditEvent(
    orgId, user.id, 'user_auto_joined_by_domain', 'user', user.id,
    { email, role: 'member', autoJoinedOrg: true }
  );
  return { kind: 'autoJoined', user };
}

async function _registerPending({ email, password, companyName, domain }) {
  // Transactional: org + user + membership + token, all-or-nothing.
  // The email send happens AFTER commit — if it fails the user can
  // resend via /resend-verification, no partial DB state to clean up.
  const client = await db.getClient();
  let user, token;
  try {
    await client.query('BEGIN');

    const newOrg = await client.query(
      `INSERT INTO organizations (name, domain, domain_restriction_enabled, created_via, status)
       VALUES ($1, $2, true, 'signup', 'active')
       RETURNING id`,
      [companyName, domain]
    );
    const orgId = newOrg.rows[0].id;

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const userResult = await client.query(
      `INSERT INTO users (email, password_hash, organization_id, status, email_verified_at)
       VALUES ($1, $2, $3, 'active', NULL)
       RETURNING id, email, organization_id, created_at`,
      [email, passwordHash, orgId]
    );
    user = userResult.rows[0];

    // Pre-create the owner membership so verification = single UPDATE
    // (verified_at + email_verified_at) rather than a multi-step dance.
    await client.query(
      `INSERT INTO organization_members (organization_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [orgId, user.id]
    );

    token = crypto.randomBytes(32).toString('base64url');
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);
    await client.query(
      `INSERT INTO email_verification_tokens (user_id, token_hash, purpose, expires_at)
       VALUES ($1, $2, 'signup', $3)`,
      [user.id, tokenHash, expiresAt]
    );

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Fire the email. Failure is logged but doesn't block the signup —
  // user can resend. Don't leak provider errors to the caller.
  const send = await transactionalEmail.sendVerificationEmail({
    to: email, companyName, token,
  });
  if (!send.ok) {
    logger.warn({ email, reason: send.reason }, 'verification email send failed; user can resend');
  }

  return { kind: 'pending', user, email };
}

/**
 * Register a new user via invite acceptance.
 * Creates user and adds them to the organization with the invited role.
 */
async function registerWithInvite(email, password, inviteToken) {
  email = email.toLowerCase().trim();
  
  // Verify invite
  const invite = await db.query(
    `SELECT i.*, o.name as org_name FROM organization_invites i
     JOIN organizations o ON i.organization_id = o.id
     WHERE i.token = $1 AND i.status = 'pending' AND i.expires_at > NOW()`,
    [inviteToken]
  );

  if (invite.rows.length === 0) {
    throw new NotFoundError('Invite not found or expired');
  }

  const inv = invite.rows[0];

  // Verify email matches
  if (inv.email.toLowerCase() !== email) {
    throw new ForbiddenError('Email does not match the invite');
  }

  // Check if user already exists
  const existing = await db.query('SELECT id FROM users WHERE email = $1', [email]);
  if (existing.rows.length > 0) {
    throw new ConflictError('Email already registered. Please login and accept the invite.');
  }

  // Create user
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const result = await db.query(
    `INSERT INTO users (email, password_hash, organization_id, status)
     VALUES ($1, $2, $3, 'active')
     RETURNING id, email, organization_id, created_at`,
    [email, passwordHash, inv.organization_id]
  );
  
  const user = result.rows[0];

  // Create organization membership
  await db.query(
    `INSERT INTO organization_members (organization_id, user_id, role, invited_by)
     VALUES ($1, $2, $3, $4)`,
    [inv.organization_id, user.id, inv.role, inv.invited_by]
  );

  // Mark invite as accepted
  await db.query(
    `UPDATE organization_invites SET status = 'accepted', accepted_at = NOW() WHERE id = $1`,
    [inv.id]
  );

  // Log audit event
  await teamService.logAuditEvent(
    inv.organization_id,
    user.id,
    'invite_accepted',
    'invite',
    inv.id,
    { email, role: inv.role }
  );

  return {
    user,
    organization: {
      id: inv.organization_id,
      name: inv.org_name,
    },
  };
}

/**
 * Login user with email and password.
 * Returns access and refresh tokens.
 */
async function login(email, password) {
  email = email.toLowerCase().trim();

  const result = await db.query(
    `SELECT u.id, u.email, u.password_hash, u.organization_id, u.status, u.is_platform_admin,
            u.email_verified_at, u.totp_enabled_at, om.role, o.status AS org_status
     FROM users u
     LEFT JOIN organization_members om ON u.id = om.user_id AND u.organization_id = om.organization_id
     LEFT JOIN organizations o ON u.organization_id = o.id
     WHERE u.email = $1`,
    [email]
  );

  if (result.rows.length === 0) {
    throw new UnauthorizedError('Invalid email or password');
  }

  const user = result.rows[0];

  enforceAccountAccess(user);

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new UnauthorizedError('Invalid email or password');
  }

  // 2FA gate. If enabled, don't return real tokens — issue a short-lived
  // temp token instead and tell the caller to come back via /auth/2fa/verify
  // with the temp token + a TOTP code (or recovery code). last_active_at is
  // updated only on full login completion (verify side), so a half-finished
  // 2FA challenge doesn't look like a successful login in audit.
  if (user.totp_enabled_at != null) {
    return {
      kind: '2fa_required',
      tempToken: mintTempToken(user.id),
    };
  }

  // Update last active
  await db.query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [user.id]);

  return generateTokens(user);
}

// ── 2FA login-gate helpers ────────────────────────────────────────────

const TEMP_TOKEN_TTL = '5m';
const TEMP_TOKEN_TYPE = 'pre-2fa';

function mintTempToken(userId) {
  return jwt.sign(
    { sub: userId, type: TEMP_TOKEN_TYPE, jti: crypto.randomUUID() },
    config.JWT_SECRET,
    { expiresIn: TEMP_TOKEN_TTL }
  );
}

/**
 * Verify a pre-2fa temp token. Returns the user id on success. Throws on
 * invalid / expired / wrong-type. Caller passes the userId to
 * completeTwoFactorLogin() below.
 */
function verifyTempToken(token) {
  let payload;
  try {
    payload = jwt.verify(token, config.JWT_SECRET);
  } catch {
    throw new UnauthorizedError('2FA challenge expired. Please log in again.');
  }
  if (payload.type !== TEMP_TOKEN_TYPE || !payload.sub) {
    throw new UnauthorizedError('Invalid 2FA challenge token');
  }
  return payload.sub;
}

/**
 * Complete a 2FA-gated login: temp token + (TOTP code OR recovery code) →
 * real access + refresh tokens. Same lazy `require` for totpService as the
 * /2fa routes so this file doesn't pull otplib at startup when 2FA isn't
 * configured.
 */
async function completeTwoFactorLogin(tempToken, code) {
  const userId = verifyTempToken(tempToken);
  const r = await db.query(
    `SELECT u.id, u.email, u.organization_id, u.status, u.is_platform_admin,
            u.email_verified_at, u.totp_secret_enc, u.totp_enabled_at,
            om.role, o.status AS org_status
       FROM users u
       LEFT JOIN organization_members om ON u.id = om.user_id AND u.organization_id = om.organization_id
       LEFT JOIN organizations o ON u.organization_id = o.id
      WHERE u.id = $1`,
    [userId]
  );
  if (!r.rows.length) throw new UnauthorizedError('User not found');
  const user = r.rows[0];
  enforceAccountAccess(user);
  if (user.totp_enabled_at == null || !user.totp_secret_enc) {
    // Edge case: user disabled 2FA between login() and verify(). Let them
    // straight through — they already cleared password.
    await db.query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [user.id]);
    return generateTokens(user);
  }

  const totp = require('./totpService');
  const codeRaw = String(code || '');
  let ok = false;
  if (/^\d{6}$/.test(codeRaw.replace(/\s/g, ''))) {
    ok = totp.verifyCode(totp.decryptSecret(user.totp_secret_enc), codeRaw);
  } else {
    // Recovery code path. Single-use — mark consumed atomically.
    const hash = totp.hashRecoveryCode(codeRaw);
    const consumed = await db.query(
      `UPDATE user_recovery_codes
          SET used_at = NOW()
        WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
        RETURNING id`,
      [user.id, hash]
    );
    ok = consumed.rows.length > 0;
  }
  if (!ok) throw new UnauthorizedError('Invalid 2FA code or recovery code');

  await db.query('UPDATE users SET last_active_at = NOW() WHERE id = $1', [user.id]);
  return generateTokens(user);
}

/**
 * Reject login/refresh based on user.status and the user's organization.status.
 * Platform admins are exempt from the org check so they can always recover
 * a suspended org (they own the Suspend button — locking themselves out
 * would be a footgun).
 *
 * Distinct error messages per failure case so the UI can render the right
 * recovery copy; password-mismatch is intentionally kept generic upstream.
 */
function enforceAccountAccess(user) {
  if (user.status === 'deactivated') {
    throw new ForbiddenError('Your account has been deactivated. Contact your organization admin.');
  }
  if (user.status === 'deleted') {
    throw new ForbiddenError('This account no longer exists.');
  }
  if (user.status && user.status !== 'active') {
    throw new ForbiddenError('This account is not in an active state.');
  }
  // Block login for users who started signup but never verified their
  // email. Distinct error code so the UI can offer "resend link".
  // Platform admins are exempt (they're created via the admin script,
  // not the signup flow, and never have an unverified email).
  if (!user.is_platform_admin && user.email_verified_at == null) {
    const err = new ForbiddenError('Please verify your email before logging in. Check your inbox for the verification link.');
    err.code = 'EMAIL_NOT_VERIFIED';
    throw err;
  }
  if (user.is_platform_admin) return; // platform admins bypass org-status gate
  if (user.org_status === 'suspended') {
    throw new ForbiddenError('Your organization has been suspended. Contact support.');
  }
  if (user.org_status === 'deleted') {
    throw new ForbiddenError('Your organization no longer exists.');
  }
}

/**
 * Refresh access token using refresh token.
 */
async function refresh(refreshToken) {
  let payload;
  try {
    payload = jwt.verify(refreshToken, config.JWT_SECRET);
  } catch {
    throw new UnauthorizedError('Invalid or expired refresh token');
  }

  if (payload.type !== 'refresh') {
    throw new UnauthorizedError('Invalid token type');
  }

  const tokenHash = hashToken(refreshToken);
  const result = await db.query(
    'SELECT id, user_id FROM refresh_tokens WHERE token_hash = $1 AND expires_at > NOW()',
    [tokenHash]
  );

  if (result.rows.length === 0) {
    throw new UnauthorizedError('Refresh token not found or expired');
  }

  // Delete used refresh token (rotation)
  await db.query('DELETE FROM refresh_tokens WHERE id = $1', [result.rows[0].id]);

  // Get user with org info
  const userResult = await db.query(
    `SELECT u.id, u.email, u.organization_id, u.status, u.is_platform_admin,
            u.email_verified_at, om.role, o.status AS org_status
     FROM users u
     LEFT JOIN organization_members om ON u.id = om.user_id AND u.organization_id = om.organization_id
     LEFT JOIN organizations o ON u.organization_id = o.id
     WHERE u.id = $1`,
    [result.rows[0].user_id]
  );

  if (userResult.rows.length === 0) {
    throw new UnauthorizedError('User not found');
  }

  const user = userResult.rows[0];

  // Same gate as login() — handles deactivated/deleted users AND
  // suspended/deleted orgs. Refresh is the choke point that revalidates
  // every ~15min, so suspending an org propagates within one refresh
  // cycle without needing token revocation.
  enforceAccountAccess(user);

  return generateTokens(user);
}

/**
 * Logout by invalidating refresh token.
 */
async function logout(refreshToken) {
  const tokenHash = hashToken(refreshToken);
  await db.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [tokenHash]);
}

/**
 * Look up the user owning a refresh token (for audit attribution).
 * Returns { id, organization_id } or null.
 */
async function findActorByRefreshToken(refreshToken) {
  const tokenHash = hashToken(refreshToken);
  const r = await db.query(
    `SELECT u.id, u.organization_id
       FROM refresh_tokens rt
       JOIN users u ON rt.user_id = u.id
      WHERE rt.token_hash = $1
      LIMIT 1`,
    [tokenHash]
  );
  return r.rows[0] || null;
}

/**
 * Generate access and refresh tokens for a user.
 */
async function generateTokens(user) {
  const accessPayload = {
    sub: user.id,
    email: user.email,
    type: 'access',
    // Same jti rationale as the refresh token below: JWT.iat resolves to
    // seconds. Without a nonce, a login+immediate-refresh in the same
    // wall-clock second produces a byte-identical access token, which made
    // "new token should differ from old" tests flake. jti also doubles as
    // a per-issuance correlation id in logs.
    jti: crypto.randomUUID(),
  };

  // Include org info if user belongs to an organization
  if (user.organization_id) {
    accessPayload.orgId = user.organization_id;
    accessPayload.role = user.role || 'member';
  }

  // Cross-org platform admins gate the /admin surface and unlock impersonation.
  if (user.is_platform_admin) {
    accessPayload.isPlatformAdmin = true;
  }
  // Impersonation/backdoor entry: caller passes user._impersonatedBy = adminId
  // so the minted token carries that attribution. Not persisted in DB.
  if (user._impersonatedBy) {
    accessPayload.impersonatedBy = user._impersonatedBy;
  }

  const accessToken = jwt.sign(accessPayload, config.JWT_SECRET, {
    expiresIn: config.JWT_ACCESS_EXPIRY,
  });

  // jti makes each refresh token byte-unique even when issued in the same
  // wall-clock second. Without it, JWT.iat is seconds-resolution and rotation
  // can emit a token byte-identical to the one it just deleted — silently
  // breaking reuse-detection in /refresh.
  const refreshToken = jwt.sign(
    { sub: user.id, type: 'refresh', jti: crypto.randomUUID() },
    config.JWT_SECRET,
    { expiresIn: config.JWT_REFRESH_EXPIRY }
  );

  const tokenHash = hashToken(refreshToken);
  const expiresAt = new Date(Date.now() + parseExpiry(config.JWT_REFRESH_EXPIRY));

  await db.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [user.id, tokenHash, expiresAt]
  );

  return {
    accessToken,
    refreshToken,
    expiresIn: parseExpiry(config.JWT_ACCESS_EXPIRY) / 1000,
    user: {
      id: user.id,
      email: user.email,
      organizationId: user.organization_id,
      role: user.role,
      isPlatformAdmin: !!user.is_platform_admin,
    },
  };
}

/**
 * Hash a token for storage.
 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Parse expiry string (e.g., '15m', '7d') to milliseconds.
 */
function parseExpiry(expiry) {
  const match = expiry.match(/^(\d+)([smhd])$/);
  if (!match) return 900000; // default 15 minutes
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const multipliers = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  return value * (multipliers[unit] || 60000);
}

/**
 * Get user's current organization info.
 */
async function getUserOrgInfo(userId) {
  const result = await db.query(
    `SELECT u.organization_id, o.name as org_name, o.domain, om.role
     FROM users u
     LEFT JOIN organizations o ON u.organization_id = o.id
     LEFT JOIN organization_members om ON u.id = om.user_id AND u.organization_id = om.organization_id
     WHERE u.id = $1`,
    [userId]
  );

  if (result.rows.length === 0 || !result.rows[0].organization_id) {
    return null;
  }

  const row = result.rows[0];
  return {
    id: row.organization_id,
    name: row.org_name,
    domain: row.domain,
    role: row.role,
  };
}

/**
 * Verify a signup token, mark the user + their org verified, and
 * issue an access/refresh token pair (auto-login on success).
 *
 * Race-safety: wrapped in a transaction with SELECT ... FOR UPDATE on
 * the org row. If a different signup for the same domain already
 * verified, the unique partial index on organizations.LOWER(domain)
 * WHERE verified_at IS NOT NULL will reject this org's verification —
 * we catch that and return a friendly "domain already claimed".
 */
async function verifyEmail(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') {
    throw new ApiError(400, 'VALIDATION_ERROR', 'Verification token is required.');
  }
  const tokenHash = hashToken(rawToken);
  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Look up token + user, lock the relevant rows.
    const tokenRow = await client.query(
      `SELECT t.id, t.user_id, t.expires_at, t.used_at,
              u.email, u.organization_id
         FROM email_verification_tokens t
         JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 AND t.purpose = 'signup'
        FOR UPDATE OF t`,
      [tokenHash]
    );
    if (tokenRow.rows.length === 0) {
      throw new NotFoundError('Verification link is invalid.');
    }
    const t = tokenRow.rows[0];
    if (t.used_at != null) {
      throw new ForbiddenError('Verification link has already been used. Please log in.');
    }
    if (new Date(t.expires_at) < new Date()) {
      throw new ForbiddenError('Verification link has expired. Request a new one.');
    }

    // Mark token used (single-use).
    await client.query(
      'UPDATE email_verification_tokens SET used_at = NOW() WHERE id = $1',
      [t.id]
    );

    // Mark user email verified.
    await client.query(
      'UPDATE users SET email_verified_at = NOW() WHERE id = $1',
      [t.user_id]
    );

    // Mark the org verified — this is where the unique partial index
    // on LOWER(domain) WHERE verified_at IS NOT NULL bites if another
    // signup got there first. Translate the constraint error into a
    // friendly message.
    try {
      await client.query(
        `UPDATE organizations SET verified_at = NOW()
           WHERE id = $1 AND verified_at IS NULL`,
        [t.organization_id]
      );
    } catch (err) {
      if (err.code === '23505') {
        throw new ConflictError('Your company domain has already been claimed by another account. Please ask them for an invite.');
      }
      throw err;
    }

    await client.query('COMMIT');

    // Issue tokens for auto-login. Re-fetch with the same SELECT shape
    // login() uses so generateTokens has everything it needs.
    const userResult = await db.query(
      `SELECT u.id, u.email, u.organization_id, u.status, u.is_platform_admin,
              u.email_verified_at, om.role, o.status AS org_status
         FROM users u
         LEFT JOIN organization_members om
           ON u.id = om.user_id AND u.organization_id = om.organization_id
         LEFT JOIN organizations o ON u.organization_id = o.id
        WHERE u.id = $1`,
      [t.user_id]
    );
    const user = userResult.rows[0];
    return generateTokens(user);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Resend a verification email for an unverified signup. Throttled to
 * 1/min/user via the latest token's created_at — independent of any
 * IP-level rate limit on the route.
 *
 * Intentionally returns success even when the email doesn't exist or
 * is already verified — don't leak which addresses have pending
 * signups (account enumeration mitigation). Real failures (rate
 * limit hit, send error) do surface.
 */
async function resendVerificationEmail(email) {
  email = (email || '').toLowerCase().trim();
  if (!email) throw new ApiError(400, 'VALIDATION_ERROR', 'Email is required.');

  const userRow = await db.query(
    `SELECT u.id, u.email_verified_at, o.name AS org_name
       FROM users u
       LEFT JOIN organizations o ON u.organization_id = o.id
      WHERE u.email = $1`,
    [email]
  );
  // Quietly succeed for unknown / already-verified accounts.
  if (userRow.rows.length === 0) return { ok: true, sent: false };
  const u = userRow.rows[0];
  if (u.email_verified_at != null) return { ok: true, sent: false };

  // Throttle: refuse if the most recent token was issued within
  // RESEND_MIN_INTERVAL_MS.
  const lastToken = await db.query(
    `SELECT created_at FROM email_verification_tokens
      WHERE user_id = $1 AND purpose = 'signup'
      ORDER BY created_at DESC LIMIT 1`,
    [u.id]
  );
  if (lastToken.rows.length > 0) {
    const age = Date.now() - new Date(lastToken.rows[0].created_at).getTime();
    if (age < RESEND_MIN_INTERVAL_MS) {
      const wait = Math.ceil((RESEND_MIN_INTERVAL_MS - age) / 1000);
      const err = new ForbiddenError(`Please wait ${wait} seconds before requesting another verification email.`);
      err.code = 'RESEND_THROTTLED';
      throw err;
    }
  }

  const token = crypto.randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + VERIFICATION_TOKEN_TTL_MS);
  await db.query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, purpose, expires_at)
     VALUES ($1, $2, 'signup', $3)`,
    [u.id, tokenHash, expiresAt]
  );

  await transactionalEmail.sendVerificationEmail({
    to: email,
    companyName: u.org_name || 'your organization',
    token,
  });
  return { ok: true, sent: true };
}

module.exports = {
  register,
  registerWithInvite,
  login,
  refresh,
  logout,
  findActorByRefreshToken,
  getUserOrgInfo,
  verifyEmail,
  resendVerificationEmail,
  completeTwoFactorLogin,
};
