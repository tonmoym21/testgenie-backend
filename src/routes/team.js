const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { requireRole, attachOrgContext } = require('../middleware/rbac');
const teamService = require('../services/teamService');

const router = Router();

// ─────────────────────────────────────────────────────────────────────────────
// VALIDATION SCHEMAS
// ─────────────────────────────────────────────────────────────────────────────

const inviteSchema = z.object({
  email: z.string().email().max(255),
  role: z.enum(['admin', 'member', 'viewer']).default('member'),
});

const bulkInviteSchema = z.object({
  invites: z.array(z.object({
    email: z.string().email().max(255),
    role: z.enum(['admin', 'member', 'viewer']).default('member'),
  })).min(1).max(20),
});

const updateRoleSchema = z.object({
  role: z.enum(['admin', 'member', 'viewer']),
});

const updateOrgSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  logoUrl: z.string().url().max(500).optional().nullable(),
  domainRestrictionEnabled: z.boolean().optional(),
});

const addDomainSchema = z.object({
  domain: z.string().min(3).max(100),
});

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC INVITE ROUTES (must be declared BEFORE any catch-all middleware and
// MUST NOT require auth — they power the invite-acceptance page for logged-out users)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/team/invite-info?token=xxx
 * Public endpoint — returns invite info without requiring auth.
 * Frontend uses this to render the accept-invite page for both logged-in and
 * logged-out users.
 */
router.get('/invite-info', async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({
        error: { code: 'MISSING_TOKEN', message: 'Invite token is required' },
      });
    }

    const invite = await teamService.getInviteByToken(token);
    if (!invite) {
      return res.status(404).json({
        error: { code: 'INVITE_NOT_FOUND', message: 'Invite not found. The link may be invalid.' },
      });
    }

    // Return 200 even when invite is expired/revoked/accepted — the frontend
    // needs the isValid/isExpired flags to render the appropriate state.
    res.json(invite);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/team/accept-invite
 * Public-tolerant: uses optionalAuth so we can return a useful, specific error
 * for unauthenticated callers instead of a generic "Missing or malformed
 * authorization header" message.
 *
 * Flow:
 *  - Logged in + email matches invite → accept and return membership
 *  - Logged in + email mismatches → 403 WRONG_ACCOUNT
 *  - Not logged in → 401 AUTH_REQUIRED_FOR_INVITE (frontend shows login/register)
 */
router.post('/accept-invite', optionalAuth, async (req, res, next) => {
  try {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({
        error: { code: 'MISSING_TOKEN', message: 'Invite token is required' },
      });
    }

    // Not authenticated → tell the frontend exactly what to do.
    if (!req.user || !req.user.id) {
      return res.status(401).json({
        error: {
          code: 'AUTH_REQUIRED_FOR_INVITE',
          message: 'Please sign in or create an account to accept this invite.',
        },
      });
    }

    const result = await teamService.acceptInvite(token, req.user.id);
    res.json(result);
  } catch (err) {
    // Map common service errors to stable codes the frontend already handles.
    if (err && err.message && err.message.toLowerCase().includes('already a member')) {
      return res.status(409).json({
        error: { code: 'ALREADY_MEMBER', message: err.message },
      });
    }
    if (err && err.message && err.message.toLowerCase().includes('different email')) {
      return res.status(403).json({
        error: { code: 'WRONG_ACCOUNT', message: err.message },
      });
    }
    if (err && err.message && (err.message.toLowerCase().includes('not found') || err.message.toLowerCase().includes('expired'))) {
      return res.status(404).json({
        error: { code: 'INVITE_INVALID', message: 'This invite is no longer valid or has expired.' },
      });
    }
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ORGANIZATION ROUTES (authenticated)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/organization', authenticate, attachOrgContext(), async (req, res, next) => {
  try {
    if (!req.organization) {
      return res.status(404).json({ error: { code: 'NO_ORG', message: 'User is not part of any organization' } });
    }

    const org = await teamService.getOrganization(req.organization.id);
    res.json({
      id: org.id,
      name: org.name,
      domain: org.domain,
      logoUrl: org.logo_url,
      domainRestrictionEnabled: org.domain_restriction_enabled,
      settings: org.settings,
      userRole: req.organization.role,
    });
  } catch (err) {
    next(err);
  }
});

router.patch('/organization', authenticate, requireRole(['owner', 'admin']), validate(updateOrgSchema), async (req, res, next) => {
  try {
    const org = await teamService.updateOrganization(req.organization.id, req.user.id, req.body);
    res.json({
      id: org.id,
      name: org.name,
      domain: org.domain,
      logoUrl: org.logo_url,
      domainRestrictionEnabled: org.domain_restriction_enabled,
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MEMBERS ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// Lightweight list of assignable org members for every authenticated user.
// Used to populate assignee dropdowns — no admin role required.
router.get('/assignable-members', authenticate, attachOrgContext(), async (req, res, next) => {
  try {
    if (!req.organization) {
      return res.json({ members: [] });
    }
    const result = await teamService.listMembers(req.organization.id, { limit: 500, offset: 0 });
    const members = (result.members || result.data || result || []).map((m) => ({
      id: m.id,
      email: m.email,
      displayName: m.displayName || m.display_name || null,
      avatarUrl: m.avatarUrl || m.avatar_url || null,
    }));
    res.json({ members });
  } catch (err) {
    next(err);
  }
});

router.get('/members', authenticate, requireRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const options = {
      status: req.query.status,
      role: req.query.role,
      search: req.query.search,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
      offset: req.query.offset ? parseInt(req.query.offset, 10) : 0,
    };
    const result = await teamService.listMembers(req.organization.id, options);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.get('/members/:userId', authenticate, requireRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const member = await teamService.getMember(req.organization.id, parseInt(req.params.userId, 10));
    res.json(member);
  } catch (err) {
    next(err);
  }
});

router.patch('/members/:userId/role', authenticate, requireRole(['owner', 'admin']), validate(updateRoleSchema), async (req, res, next) => {
  try {
    const member = await teamService.updateMemberRole(
      req.organization.id,
      parseInt(req.params.userId, 10),
      req.body.role,
      req.user.id
    );
    res.json(member);
  } catch (err) {
    next(err);
  }
});

router.delete('/members/:userId', authenticate, requireRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const result = await teamService.removeMember(
      req.organization.id,
      parseInt(req.params.userId, 10),
      req.user.id
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post('/members/:userId/deactivate', authenticate, requireRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const member = await teamService.deactivateMember(
      req.organization.id,
      parseInt(req.params.userId, 10),
      req.user.id
    );
    res.json(member);
  } catch (err) {
    next(err);
  }
});

router.post('/members/:userId/reactivate', authenticate, requireRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const member = await teamService.reactivateMember(
      req.organization.id,
      parseInt(req.params.userId, 10),
      req.user.id
    );
    res.json(member);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// INVITE ADMIN ROUTES (authenticated)
// ─────────────────────────────────────────────────────────────────────────────

router.get('/invites', authenticate, requireRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const status = req.query.status || 'pending';
    const invites = await teamService.listInvites(req.organization.id, status);
    res.json({ invites });
  } catch (err) {
    next(err);
  }
});

router.post('/invites', authenticate, requireRole(['owner', 'admin']), validate(inviteSchema), async (req, res, next) => {
  try {
    if (req.body.role === 'admin' && req.organization.role !== 'owner') {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'Only owners can invite admin users' },
      });
    }

    const invite = await teamService.createInvite(
      req.organization.id,
      req.body.email,
      req.body.role,
      req.user.id
    );
    res.status(201).json(invite);
  } catch (err) {
    next(err);
  }
});

router.post('/invites/bulk', authenticate, requireRole(['owner', 'admin']), validate(bulkInviteSchema), async (req, res, next) => {
  try {
    const results = [];
    const errors = [];

    for (const inv of req.body.invites) {
      if (inv.role === 'admin' && req.organization.role !== 'owner') {
        errors.push({ email: inv.email, error: 'Only owners can invite admin users' });
        continue;
      }

      try {
        const invite = await teamService.createInvite(
          req.organization.id,
          inv.email,
          inv.role,
          req.user.id
        );
        results.push(invite);
      } catch (err) {
        errors.push({ email: inv.email, error: err.message });
      }
    }

    res.status(201).json({ created: results, errors });
  } catch (err) {
    next(err);
  }
});

router.post('/invites/:inviteId/resend', authenticate, requireRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const result = await teamService.resendInvite(
      req.organization.id,
      parseInt(req.params.inviteId, 10),
      req.user.id
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.delete('/invites/:inviteId', authenticate, requireRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const result = await teamService.revokeInvite(
      req.organization.id,
      parseInt(req.params.inviteId, 10),
      req.user.id
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWED DOMAINS ROUTES
// ─────────────────────────────────────────────────────────────────────────────

router.get('/domains', authenticate, requireRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const domains = await teamService.listAllowedDomains(req.organization.id);
    res.json({ domains });
  } catch (err) {
    next(err);
  }
});

router.post('/domains', authenticate, requireRole(['owner', 'admin']), validate(addDomainSchema), async (req, res, next) => {
  try {
    const domain = await teamService.addAllowedDomain(
      req.organization.id,
      req.body.domain,
      req.user.id
    );
    res.status(201).json(domain);
  } catch (err) {
    next(err);
  }
});

router.delete('/domains/:domainId', authenticate, requireRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const result = await teamService.removeAllowedDomain(
      req.organization.id,
      parseInt(req.params.domainId, 10),
      req.user.id
    );
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT LOGS ROUTE
// ─────────────────────────────────────────────────────────────────────────────

router.get('/audit-logs', authenticate, requireRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const options = {
      action: req.query.action,
      actorId: req.query.actorId ? parseInt(req.query.actorId, 10) : undefined,
      limit: req.query.limit ? parseInt(req.query.limit, 10) : 50,
      offset: req.query.offset ? parseInt(req.query.offset, 10) : 0,
    };
    const logs = await teamService.getAuditLogs(req.organization.id, options);
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CURRENT USER TEAM INFO
// ─────────────────────────────────────────────────────────────────────────────

router.get('/me', authenticate, attachOrgContext(), async (req, res, next) => {
  try {
    if (!req.organization) {
      return res.json({
        hasOrganization: false,
        organization: null,
        role: null,
      });
    }

    const org = await teamService.getOrganization(req.organization.id);

    res.json({
      hasOrganization: true,
      organization: {
        id: org.id,
        name: org.name,
        domain: org.domain,
      },
      role: req.organization.role,
      canManageTeam: ['owner', 'admin'].includes(req.organization.role),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
