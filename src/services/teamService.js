const crypto = require('crypto');
const db = require('../db');
const { ConflictError, NotFoundError, ForbiddenError, ValidationError } = require('../utils/apiError');
const logger = require('../utils/logger');
const emailService = require('./emailService');

// Role hierarchy for permission checks
const ROLE_HIERARCHY = { owner: 4, admin: 3, member: 2, viewer: 1 };

// ─────────────────────────────────────────────────────────────────────────────
// SAFE EMAIL WRAPPER
// Email delivery for invites/welcome is currently PARKED — the emailService
// module does not implement sendInviteEmail/sendWelcomeEmail. We still want
// invite creation and resend to succeed and return the invite URL so admins
// can share it manually. This wrapper:
//   - calls the real method if it exists AND the `mail` feature flag is on
//   - otherwise no-ops and returns { success: false, reason: 'MAIL_DISABLED' }
//   - never throws — email failures must NEVER fail invite creation
// To re-enable mail later, implement sendInviteEmail/sendWelcomeEmail on
// emailService and (optionally) set MAIL_ENABLED=true in the environment.
// ─────────────────────────────────────────────────────────────────────────────
const MAIL_ENABLED = process.env.MAIL_ENABLED === 'true';

async function safeEmail(methodName, payload) {
  if (!MAIL_ENABLED) {
    logger.info({ methodName, to: payload?.email }, 'Mail disabled — skipping');
    return { success: false, reason: 'MAIL_DISABLED' };
  }
  const fn = emailService && typeof emailService[methodName] === 'function'
    ? emailService[methodName]
    : null;
  if (!fn) {
    logger.warn({ methodName }, 'Mail method not implemented — skipping');
    return { success: false, reason: 'NOT_IMPLEMENTED' };
  }
  try {
    const result = await fn(payload);
    return result || { success: true };
  } catch (err) {
    logger.error({ err: err.message, methodName }, 'Mail send failed — continuing without it');
    return { success: false, reason: 'SEND_FAILED', error: err.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ORGANIZATION
// ─────────────────────────────────────────────────────────────────────────────

async function getOrganization(orgId) {
  const result = await db.query(
    `SELECT id, name, domain, logo_url, settings, domain_restriction_enabled, created_at, updated_at
     FROM organizations WHERE id = $1`,
    [orgId]
  );
  if (result.rows.length === 0) throw new NotFoundError('Organization');
  return result.rows[0];
}

async function updateOrganization(orgId, actorId, updates) {
  const { name, logoUrl, domainRestrictionEnabled } = updates;
  const fields = [];
  const values = [];
  let idx = 1;

  if (name !== undefined) {
    fields.push(`name = $${idx++}`);
    values.push(name);
  }
  if (logoUrl !== undefined) {
    fields.push(`logo_url = $${idx++}`);
    values.push(logoUrl);
  }
  if (domainRestrictionEnabled !== undefined) {
    fields.push(`domain_restriction_enabled = $${idx++}`);
    values.push(domainRestrictionEnabled);
  }

  if (fields.length === 0) return getOrganization(orgId);

  values.push(orgId);
  const result = await db.query(
    `UPDATE organizations SET ${fields.join(', ')} WHERE id = $${idx} RETURNING *`,
    values
  );

  await logAuditEvent(orgId, actorId, 'organization_updated', 'organization', orgId, updates);
  return result.rows[0];
}

async function getOrCreateOrgByDomain(domain) {
  // Check existing
  let result = await db.query('SELECT id FROM organizations WHERE domain = $1', [domain]);
  if (result.rows.length > 0) return result.rows[0].id;

  // Create new org
  const orgName = domain.split('.')[0].charAt(0).toUpperCase() + domain.split('.')[0].slice(1);
  const newOrg = await db.query(
    `INSERT INTO organizations (name, domain) VALUES ($1, $2) RETURNING id`,
    [orgName, domain]
  );
  return newOrg.rows[0].id;
}

// ─────────────────────────────────────────────────────────────────────────────
// MEMBERS
// ─────────────────────────────────────────────────────────────────────────────

async function listMembers(orgId, options = {}) {
  const { status = 'active', search, role, limit = 50, offset = 0 } = options;
  
  let query = `
    SELECT u.id, u.email, u.display_name, u.avatar_url, u.status, u.last_active_at,
           om.role, om.joined_at, om.invited_by,
           inviter.email as invited_by_email
    FROM users u
    JOIN organization_members om ON u.id = om.user_id
    LEFT JOIN users inviter ON om.invited_by = inviter.id
    WHERE om.organization_id = $1
  `;
  const params = [orgId];
  let idx = 2;

  if (status && status !== 'all') {
    query += ` AND u.status = $${idx++}`;
    params.push(status);
  }
  if (search) {
    query += ` AND (u.email ILIKE $${idx} OR u.display_name ILIKE $${idx})`;
    params.push(`%${search}%`);
    idx++;
  }
  if (role) {
    query += ` AND om.role = $${idx++}`;
    params.push(role);
  }

  query += ` ORDER BY om.role DESC, u.email ASC LIMIT $${idx++} OFFSET $${idx++}`;
  params.push(limit, offset);

  const result = await db.query(query, params);

  // Get total count
  let countQuery = `
    SELECT COUNT(*) as total FROM users u
    JOIN organization_members om ON u.id = om.user_id
    WHERE om.organization_id = $1
  `;
  const countParams = [orgId];
  let cidx = 2;
  if (status && status !== 'all') {
    countQuery += ` AND u.status = $${cidx++}`;
    countParams.push(status);
  }
  if (search) {
    countQuery += ` AND (u.email ILIKE $${cidx} OR u.display_name ILIKE $${cidx})`;
    countParams.push(`%${search}%`);
  }
  if (role) {
    countQuery += ` AND om.role = $${cidx++}`;
    countParams.push(role);
  }

  const countResult = await db.query(countQuery, countParams);

  return {
    members: result.rows.map(formatMember),
    total: parseInt(countResult.rows[0].total, 10),
    limit,
    offset,
  };
}

async function getMember(orgId, userId) {
  const result = await db.query(
    `SELECT u.id, u.email, u.display_name, u.avatar_url, u.status, u.last_active_at,
            om.role, om.joined_at, om.invited_by
     FROM users u
     JOIN organization_members om ON u.id = om.user_id
     WHERE om.organization_id = $1 AND u.id = $2`,
    [orgId, userId]
  );
  if (result.rows.length === 0) throw new NotFoundError('Member');
  return formatMember(result.rows[0]);
}

async function getUserOrgRole(userId, orgId) {
  const result = await db.query(
    `SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2`,
    [userId, orgId]
  );
  return result.rows.length > 0 ? result.rows[0].role : null;
}

async function updateMemberRole(orgId, targetUserId, newRole, actorId) {
  // Validate role
  if (!['admin', 'member', 'viewer'].includes(newRole)) {
    throw new ValidationError([{ field: 'role', message: 'Invalid role. Must be admin, member, or viewer' }]);
  }

  // Get actor's role
  const actorRole = await getUserOrgRole(actorId, orgId);
  if (!actorRole || !['owner', 'admin'].includes(actorRole)) {
    throw new ForbiddenError('Only owners and admins can change roles');
  }

  // Get target's current role
  const targetRole = await getUserOrgRole(targetUserId, orgId);
  if (!targetRole) throw new NotFoundError('Member');

  // Owners cannot be demoted by admins
  if (targetRole === 'owner' && actorRole !== 'owner') {
    throw new ForbiddenError('Only owners can modify other owners');
  }

  // Cannot change own role unless owner
  if (targetUserId === actorId && actorRole !== 'owner') {
    throw new ForbiddenError('Cannot change your own role');
  }

  // Admins cannot promote to admin
  if (actorRole === 'admin' && newRole === 'admin') {
    throw new ForbiddenError('Only owners can promote users to admin');
  }

  const result = await db.query(
    `UPDATE organization_members SET role = $1 WHERE organization_id = $2 AND user_id = $3 RETURNING *`,
    [newRole, orgId, targetUserId]
  );

  await logAuditEvent(orgId, actorId, 'role_changed', 'user', targetUserId, {
    oldRole: targetRole,
    newRole,
  });

  return getMember(orgId, targetUserId);
}

async function removeMember(orgId, targetUserId, actorId) {
  const actorRole = await getUserOrgRole(actorId, orgId);
  const targetRole = await getUserOrgRole(targetUserId, orgId);

  if (!targetRole) throw new NotFoundError('Member');

  // Permission checks
  if (!['owner', 'admin'].includes(actorRole)) {
    throw new ForbiddenError('Only owners and admins can remove members');
  }
  if (targetRole === 'owner') {
    throw new ForbiddenError('Cannot remove organization owner');
  }
  if (actorRole === 'admin' && targetRole === 'admin') {
    throw new ForbiddenError('Admins cannot remove other admins');
  }

  // Cannot remove self
  if (targetUserId === actorId) {
    throw new ForbiddenError('Cannot remove yourself');
  }

  // Get user email for audit
  const userResult = await db.query('SELECT email FROM users WHERE id = $1', [targetUserId]);
  const userEmail = userResult.rows[0]?.email;

  // Remove membership
  await db.query(
    `DELETE FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
    [orgId, targetUserId]
  );

  // Clear user's organization_id
  await db.query(`UPDATE users SET organization_id = NULL WHERE id = $1`, [targetUserId]);

  await logAuditEvent(orgId, actorId, 'member_removed', 'user', targetUserId, { email: userEmail });

  return { success: true, removedUserId: targetUserId };
}

async function deactivateMember(orgId, targetUserId, actorId) {
  const actorRole = await getUserOrgRole(actorId, orgId);
  const targetRole = await getUserOrgRole(targetUserId, orgId);

  if (!targetRole) throw new NotFoundError('Member');
  if (!['owner', 'admin'].includes(actorRole)) {
    throw new ForbiddenError('Only owners and admins can deactivate members');
  }
  if (targetRole === 'owner') {
    throw new ForbiddenError('Cannot deactivate organization owner');
  }
  if (targetUserId === actorId) {
    throw new ForbiddenError('Cannot deactivate yourself');
  }

  await db.query(
    `UPDATE users SET status = 'deactivated', deactivated_at = NOW(), deactivated_by = $1 WHERE id = $2`,
    [actorId, targetUserId]
  );

  await logAuditEvent(orgId, actorId, 'member_deactivated', 'user', targetUserId, {});

  return getMember(orgId, targetUserId);
}

async function reactivateMember(orgId, targetUserId, actorId) {
  const actorRole = await getUserOrgRole(actorId, orgId);
  if (!['owner', 'admin'].includes(actorRole)) {
    throw new ForbiddenError('Only owners and admins can reactivate members');
  }

  await db.query(
    `UPDATE users SET status = 'active', deactivated_at = NULL, deactivated_by = NULL WHERE id = $1`,
    [targetUserId]
  );

  await logAuditEvent(orgId, actorId, 'member_reactivated', 'user', targetUserId, {});

  return getMember(orgId, targetUserId);
}

// ─────────────────────────────────────────────────────────────────────────────
// INVITES
// ─────────────────────────────────────────────────────────────────────────────

async function createInvite(orgId, email, role, invitedBy) {
  email = email.toLowerCase().trim();
  
  // Validate role
  if (!['admin', 'member', 'viewer'].includes(role)) {
    throw new ValidationError([{ field: 'role', message: 'Invalid role' }]);
  }

  // Get org info for email
  const org = await getOrganization(orgId);

  // Check if domain restriction is enabled
  if (org.domain_restriction_enabled) {
    const emailDomain = email.split('@')[1];
    const allowedResult = await db.query(
      `SELECT domain FROM allowed_email_domains WHERE organization_id = $1`,
      [orgId]
    );
    const allowedDomains = allowedResult.rows.map((r) => r.domain);
    
    // Include org's primary domain
    if (org.domain) allowedDomains.push(org.domain);
    
    if (!allowedDomains.includes(emailDomain)) {
      throw new ForbiddenError(`Email domain ${emailDomain} is not allowed. Allowed domains: ${allowedDomains.join(', ')}`);
    }
  }

  // Check if user already exists and is a member
  const existingUser = await db.query(
    `SELECT u.id, om.id as membership_id FROM users u
     LEFT JOIN organization_members om ON u.id = om.user_id AND om.organization_id = $1
     WHERE u.email = $2`,
    [orgId, email]
  );
  if (existingUser.rows[0]?.membership_id) {
    throw new ConflictError('User is already a member of this organization');
  }

  // Get inviter's email (used for email template)
  const inviterResult = await db.query('SELECT email FROM users WHERE id = $1', [invitedBy]);
  const inviterEmail = inviterResult.rows[0]?.email || 'A team member';

  // If a pending invite already exists for this email, treat this as a
  // "refresh & resend": rotate the token, extend expiry, update role if changed,
  // and return the invite with a fresh URL. This is idempotent and matches user
  // expectation when they click "Send invite" for someone they already invited.
  const existing = await db.query(
    `SELECT id, role FROM organization_invites
     WHERE organization_id = $1 AND LOWER(email) = LOWER($2) AND status = 'pending'
     ORDER BY created_at DESC LIMIT 1`,
    [orgId, email]
  );

  if (existing.rows.length > 0) {
    const existingInviteId = existing.rows[0].id;
    const existingRole = existing.rows[0].role;
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const updated = await db.query(
      `UPDATE organization_invites
         SET token = $1, expires_at = $2, role = $3, invited_by = $4
         WHERE id = $5
         RETURNING id, email, role, status, expires_at, created_at`,
      [token, expiresAt, role, invitedBy, existingInviteId]
    );

    await logAuditEvent(orgId, invitedBy, 'invite_refreshed', 'invite', existingInviteId, {
      email,
      oldRole: existingRole,
      newRole: role,
    });

    const inviteUrl = `/accept-invite?token=${token}`;
    const emailResult = await safeEmail('sendInviteEmail', {
      email,
      inviteUrl,
      organizationName: org.name,
      role,
      inviterEmail,
    });

    return {
      ...updated.rows[0],
      token,
      inviteUrl,
      emailSent: emailResult.success,
      emailError: emailResult.reason,
      mailDisabled: emailResult.reason === 'MAIL_DISABLED' || emailResult.reason === 'NOT_IMPLEMENTED',
      reused: true,
    };
  }

  // No pending invite exists (or previous one was revoked/expired/accepted) —
  // create a brand-new invite record.
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const result = await db.query(
    `INSERT INTO organization_invites (organization_id, email, role, token, invited_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, email, role, status, expires_at, created_at`,
    [orgId, email, role, token, invitedBy, expiresAt]
  );

  await logAuditEvent(orgId, invitedBy, 'invite_sent', 'invite', result.rows[0].id, { email, role });

  // Send invite email (no-op if mail is disabled/parked — invite creation still succeeds)
  const inviteUrl = `/accept-invite?token=${token}`;
  const emailResult = await safeEmail('sendInviteEmail', {
    email,
    inviteUrl,
    organizationName: org.name,
    role,
    inviterEmail,
  });

  return {
    ...result.rows[0],
    token,
    inviteUrl,
    emailSent: emailResult.success,
    emailError: emailResult.reason,
    mailDisabled: emailResult.reason === 'MAIL_DISABLED' || emailResult.reason === 'NOT_IMPLEMENTED',
    reused: false,
  };
}

async function listInvites(orgId, status = 'pending') {
  let query = `
    SELECT i.id, i.email, i.role, i.status, i.expires_at, i.created_at,
           u.email as invited_by_email
    FROM organization_invites i
    JOIN users u ON i.invited_by = u.id
    WHERE i.organization_id = $1
  `;
  const params = [orgId];

  if (status && status !== 'all') {
    query += ` AND i.status = $2`;
    params.push(status);
  }

  query += ` ORDER BY i.created_at DESC`;

  const result = await db.query(query, params);
  return result.rows.map((r) => ({
    id: r.id,
    email: r.email,
    role: r.role,
    status: r.status,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
    invitedByEmail: r.invited_by_email,
    isExpired: new Date(r.expires_at) < new Date(),
  }));
}

async function resendInvite(orgId, inviteId, actorId) {
  const invite = await db.query(
    `SELECT * FROM organization_invites WHERE id = $1 AND organization_id = $2`,
    [inviteId, orgId]
  );
  if (invite.rows.length === 0) throw new NotFoundError('Invite');

  if (invite.rows[0].status !== 'pending') {
    throw new ForbiddenError('Can only resend pending invites');
  }

  // Generate new token and extend expiry
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  await db.query(
    `UPDATE organization_invites SET token = $1, expires_at = $2 WHERE id = $3`,
    [token, expiresAt, inviteId]
  );

  await logAuditEvent(orgId, actorId, 'invite_resent', 'invite', inviteId, { email: invite.rows[0].email });

  // Get org info for email
  const org = await getOrganization(orgId);
  
  // Get inviter's email
  const inviterResult = await db.query('SELECT email FROM users WHERE id = $1', [actorId]);
  const inviterEmail = inviterResult.rows[0]?.email || 'A team member';

  // Send invite email again (no-op if mail parked)
  const inviteUrl = `/accept-invite?token=${token}`;
  const emailResult = await safeEmail('sendInviteEmail', {
    email: invite.rows[0].email,
    inviteUrl,
    organizationName: org.name,
    role: invite.rows[0].role,
    inviterEmail,
  });

  return {
    id: inviteId,
    email: invite.rows[0].email,
    role: invite.rows[0].role,
    status: 'pending',
    expiresAt: expiresAt,
    token,
    inviteUrl,
    emailSent: emailResult.success,
    emailError: emailResult.reason,
    mailDisabled: emailResult.reason === 'MAIL_DISABLED' || emailResult.reason === 'NOT_IMPLEMENTED',
  };
}

async function revokeInvite(orgId, inviteId, actorId) {
  const invite = await db.query(
    `SELECT * FROM organization_invites WHERE id = $1 AND organization_id = $2`,
    [inviteId, orgId]
  );
  if (invite.rows.length === 0) throw new NotFoundError('Invite');

  if (invite.rows[0].status !== 'pending') {
    throw new ForbiddenError('Can only revoke pending invites');
  }

  await db.query(
    `UPDATE organization_invites SET status = 'revoked' WHERE id = $1`,
    [inviteId]
  );

  await logAuditEvent(orgId, actorId, 'invite_revoked', 'invite', inviteId, { email: invite.rows[0].email });

  return { success: true, inviteId };
}

async function acceptInvite(token, userId) {
  // Find valid invite
  const invite = await db.query(
    `SELECT i.*, o.name as org_name FROM organization_invites i
     JOIN organizations o ON i.organization_id = o.id
     WHERE i.token = $1 AND i.status = 'pending' AND i.expires_at > NOW()`,
    [token]
  );

  if (invite.rows.length === 0) {
    throw new NotFoundError('Invite not found or expired');
  }

  const inv = invite.rows[0];

  // Verify user email matches invite email
  const user = await db.query('SELECT email FROM users WHERE id = $1', [userId]);
  if (user.rows[0].email.toLowerCase() !== inv.email.toLowerCase()) {
    throw new ForbiddenError('This invite was sent to a different email address');
  }

  // Check if already a member
  const existingMember = await db.query(
    `SELECT id FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
    [inv.organization_id, userId]
  );
  if (existingMember.rows.length > 0) {
    throw new ConflictError('Already a member of this organization');
  }

  // Create membership
  await db.query(
    `INSERT INTO organization_members (organization_id, user_id, role, invited_by)
     VALUES ($1, $2, $3, $4)`,
    [inv.organization_id, userId, inv.role, inv.invited_by]
  );

  // Update user's organization_id
  await db.query(
    `UPDATE users SET organization_id = $1 WHERE id = $2`,
    [inv.organization_id, userId]
  );

  // Mark invite as accepted
  await db.query(
    `UPDATE organization_invites SET status = 'accepted', accepted_at = NOW() WHERE id = $1`,
    [inv.id]
  );

  await logAuditEvent(inv.organization_id, userId, 'invite_accepted', 'invite', inv.id, {
    email: inv.email,
    role: inv.role,
  });

  // Send welcome email (no-op if mail parked)
  safeEmail('sendWelcomeEmail', {
    email: inv.email,
    organizationName: inv.org_name,
  }).catch(() => {});

  return {
    organizationId: inv.organization_id,
    organizationName: inv.org_name,
    role: inv.role,
  };
}

async function getInviteByToken(token) {
  const result = await db.query(
    `SELECT i.id, i.email, i.role, i.status, i.expires_at, o.name as org_name
     FROM organization_invites i
     JOIN organizations o ON i.organization_id = o.id
     WHERE i.token = $1`,
    [token]
  );
  if (result.rows.length === 0) return null;
  
  const inv = result.rows[0];
  return {
    id: inv.id,
    email: inv.email,
    role: inv.role,
    status: inv.status,
    organizationName: inv.org_name,
    isExpired: new Date(inv.expires_at) < new Date(),
    isValid: inv.status === 'pending' && new Date(inv.expires_at) > new Date(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWED DOMAINS
// ─────────────────────────────────────────────────────────────────────────────

async function listAllowedDomains(orgId) {
  const result = await db.query(
    `SELECT d.id, d.domain, d.created_at, d.created_by,
            u.email AS created_by_email
     FROM allowed_email_domains d
     LEFT JOIN users u ON d.created_by = u.id
     WHERE d.organization_id = $1
     ORDER BY d.created_at DESC, d.domain ASC`,
    [orgId]
  );
  return result.rows;
}

async function addAllowedDomain(orgId, domain, actorId) {
  domain = domain.toLowerCase().trim();

  // Validate domain format
  if (!/^[a-z0-9]+([\-\.]{1}[a-z0-9]+)*\.[a-z]{2,}$/i.test(domain)) {
    throw new ValidationError([{ field: 'domain', message: 'Invalid domain format' }]);
  }

  try {
    const result = await db.query(
      `INSERT INTO allowed_email_domains (organization_id, domain, created_by)
       VALUES ($1, $2, $3)
       RETURNING id, domain, created_by, created_at`,
      [orgId, domain, actorId]
    );

    await logAuditEvent(orgId, actorId, 'domain_added', 'domain', result.rows[0].id, { domain });

    // Re-attach created_by_email for immediate UI display
    const actorResult = await db.query('SELECT email FROM users WHERE id = $1', [actorId]);
    return {
      ...result.rows[0],
      created_by_email: actorResult.rows[0]?.email || null,
    };
  } catch (err) {
    if (err.code === '23505') {
      throw new ConflictError('Domain already added');
    }
    throw err;
  }
}

async function removeAllowedDomain(orgId, domainId, actorId) {
  const domain = await db.query(
    `SELECT domain FROM allowed_email_domains WHERE id = $1 AND organization_id = $2`,
    [domainId, orgId]
  );
  if (domain.rows.length === 0) throw new NotFoundError('Domain');

  await db.query(`DELETE FROM allowed_email_domains WHERE id = $1`, [domainId]);

  await logAuditEvent(orgId, actorId, 'domain_removed', 'domain', domainId, { domain: domain.rows[0].domain });

  return { success: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOGS
// ─────────────────────────────────────────────────────────────────────────────

async function logAuditEvent(orgId, actorId, action, targetType, targetId, details, req = null) {
  try {
    await db.query(
      `INSERT INTO team_audit_logs (organization_id, actor_id, action, target_type, target_id, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        orgId,
        actorId,
        action,
        targetType,
        String(targetId),
        JSON.stringify(details),
      ]
    );
  } catch (err) {
    logger.error({ err, orgId, action }, 'Failed to log audit event');
  }
}

async function getAuditLogs(orgId, options = {}) {
  const { action, actorId, limit = 50, offset = 0 } = options;

  let query = `
    SELECT l.id, l.action, l.target_type, l.target_id, l.details, l.created_at,
           u.email as actor_email
    FROM team_audit_logs l
    LEFT JOIN users u ON l.actor_id = u.id
    WHERE l.organization_id = $1
  `;
  const params = [orgId];
  let idx = 2;

  if (action) {
    query += ` AND l.action = $${idx++}`;
    params.push(action);
  }
  if (actorId) {
    query += ` AND l.actor_id = $${idx++}`;
    params.push(actorId);
  }

  query += ` ORDER BY l.created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
  params.push(limit, offset);

  const result = await db.query(query, params);
  return result.rows;
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function formatMember(row) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    status: row.status,
    role: row.role,
    joinedAt: row.joined_at,
    lastActiveAt: row.last_active_at,
    invitedBy: row.invited_by,
    invitedByEmail: row.invited_by_email,
  };
}

async function addMemberToOrg(orgId, userId, role, invitedBy = null) {
  await db.query(
    `INSERT INTO organization_members (organization_id, user_id, role, invited_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (organization_id, user_id) DO NOTHING`,
    [orgId, userId, role, invitedBy]
  );

  await db.query(`UPDATE users SET organization_id = $1 WHERE id = $2`, [orgId, userId]);
}

module.exports = {
  // Organization
  getOrganization,
  updateOrganization,
  getOrCreateOrgByDomain,
  
  // Members
  listMembers,
  getMember,
  getUserOrgRole,
  updateMemberRole,
  removeMember,
  deactivateMember,
  reactivateMember,
  addMemberToOrg,
  
  // Invites
  createInvite,
  listInvites,
  resendInvite,
  revokeInvite,
  acceptInvite,
  getInviteByToken,
  
  // Domains
  listAllowedDomains,
  addAllowedDomain,
  removeAllowedDomain,
  
  // Audit
  getAuditLogs,
  logAuditEvent,
};
