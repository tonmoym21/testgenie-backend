const { Router } = require('express');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { authenticate, optionalAuth } = require('../middleware/auth');
const { requireRole, requireMinRole, attachOrgContext } = require('../middleware/rbac');
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

const listMembersSchema = z.object({
  status: z.enum(['active', 'deactivated', 'all']).optional(),
  role: z.enum(['owner', 'admin', 'member', 'viewer']).optional(),
  search: z.string().max(100).optional(),
  limit: z.coerce.number().min(1).max(100).optional(),
  offset: z.coerce.number().min(0).optional(),
});

// ─────────────────────────────────────────────────────────────────────────────
// ORGANIZATION ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/team/organization - Get current organization details
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

// PATCH /api/team/organization - Update organization settings
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

// GET /api/team/members - List organization members
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

// GET /api/team/members/:userId - Get single member details
router.get('/members/:userId', authenticate, requireRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const member = await teamService.getMember(req.organization.id, parseInt(req.params.userId, 10));
    res.json(member);
  } catch (err) {
    next(err);
  }
});

// PATCH /api/team/members/:userId/role - Update member role
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

// DELETE /api/team/members/:userId - Remove member from organization
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

// POST /api/team/members/:userId/deactivate - Deactivate member
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

// POST /api/team/members/:userId/reactivate - Reactivate member
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
// INVITE ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/team/invites - List organization invites
router.get('/invites', authenticate, requireRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const status = req.query.status || 'pending';
    const invites = await teamService.listInvites(req.organization.id, status);
    res.json({ invites });
  } catch (err) {
    next(err);
  }
});

// POST /api/team/invites - Create single invite
router.post('/invites', authenticate, requireRole(['owner', 'admin']), validate(inviteSchema), async (req, res, next) => {
  try {
    // Only owners can invite admins
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

// POST /api/team/invites/bulk - Create multiple invites
router.post('/invites/bulk', authenticate, requireRole(['owner', 'admin']), validate(bulkInviteSchema), async (req, res, next) => {
  try {
    const results = [];
    const errors = [];

    for (const inv of req.body.invites) {
      // Only owners can invite admins
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

// POST /api/team/invites/:inviteId/resend - Resend invite
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

// DELETE /api/team/invites/:inviteId - Revoke invite
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

// GET /api/team/invite-info?token=xxx - Get invite info by token (public, for invite acceptance page)
router.get('/invite-info', async (req, res, next) => {
  try {
    const { token } = req.query;
    if (!token) {
      return res.status(400).json({ error: { code: 'MISSING_TOKEN', message: 'Token is required' } });
    }

    const invite = await teamService.getInviteByToken(token);
    if (!invite) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Invite not found' } });
    }

    res.json(invite);
  } catch (err) {
    next(err);
  }
});

// POST /api/team/accept-invite - Accept invite (authenticated)
// Uses optionalAuth so unauthenticated users get a clear "please login" error
// instead of a raw 401 from the auth middleware
router.post('/accept-invite', optionalAuth, async (req, res, next) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: { code: 'MISSING_TOKEN', message: 'Token is required' } });
    }

    if (!req.user) {
      return res.status(401).json({
        error: {
          code: 'AUTH_REQUIRED',
          message: 'Please log in or create an account to accept this invite',
        },
      });
    }

    const result = await teamService.acceptInvite(token, req.user.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ALLOWED DOMAINS ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/team/domains - List allowed email domains
router.get('/domains', authenticate, requireRole(['owner', 'admin']), async (req, res, next) => {
  try {
    const domains = await teamService.listAllowedDomains(req.organization.id);
    res.json({ domains });
  } catch (err) {
    next(err);
  }
});

// POST /api/team/domains - Add allowed email domain
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

// DELETE /api/team/domains/:domainId - Remove allowed email domain
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

// GET /api/team/audit-logs - Get team audit logs
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

// GET /api/team/me - Get current user's team membership info
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
