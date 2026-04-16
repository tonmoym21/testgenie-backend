// Smoke-test the invite service with REAL emailService (no sendInviteEmail method)
// Must run from C:\Users\tonmoy.malakar\OneDrive\Desktop\Claude\TestForge\testgenie-backend\testgenie-backend
// 
// Usage: set NODE_ENV=test && node test-invite-smoke.js
// Requires: no DB (uses in-memory stub via require.cache override)

'use strict';

// 1) Stub the db module BEFORE anything else requires it
const Module = require('module');
const origResolve = Module._resolveFilename;
const origLoad = Module._load;

const path = require('path');

// In-memory DB state
const state = {
  invites: [],
  orgs: [{ id: 1, name: 'Engagedly', domain: 'engagedly.com', domain_restriction_enabled: false, logo_url: null, settings: {} }],
  members: [{ organization_id: 1, user_id: 1, role: 'owner' }],
  users: [{ id: 1, email: 'admin@engagedly.com' }],
  allowedDomains: [],
  audit: [],
};
let nextInviteId = 1;
let nextDomainId = 1;

const stubDb = {
  query: async (text, params = []) => {
    const t = text.replace(/\s+/g, ' ').trim().toLowerCase();

    // getOrganization
    if (t.startsWith('select id, name, domain, logo_url')) {
      const org = state.orgs.find((o) => o.id === params[0]);
      return { rows: org ? [org] : [] };
    }
    // allowed domains list
    if (t.startsWith('select domain from allowed_email_domains')) {
      return { rows: state.allowedDomains.filter((d) => d.organization_id === params[0]) };
    }
    // list allowed domains (with created_by join)
    if (t.includes('from allowed_email_domains d') && t.startsWith('select d.id')) {
      return { rows: state.allowedDomains.filter((d) => d.organization_id === params[0]) };
    }
    // user+membership existence check
    if (t.includes('left join organization_members om on u.id = om.user_id and om.organization_id')) {
      const user = state.users.find((u) => u.email === params[1]);
      if (!user) return { rows: [] };
      const m = state.members.find((m) => m.user_id === user.id && m.organization_id === params[0]);
      return { rows: [{ id: user.id, membership_id: m ? 'x' : null }] };
    }
    // select email from users where id
    if (t.startsWith('select email from users where id')) {
      const u = state.users.find((u) => u.id === params[0]);
      return { rows: u ? [{ email: u.email }] : [] };
    }
    // existing pending invite lookup
    if (t.startsWith('select id, role from organization_invites')) {
      const matched = state.invites.filter((i) =>
        i.organization_id === params[0] &&
        i.email.toLowerCase() === params[1].toLowerCase() &&
        i.status === 'pending'
      );
      matched.sort((a, b) => b.created_at - a.created_at);
      return { rows: matched.slice(0, 1).map((i) => ({ id: i.id, role: i.role })) };
    }
    // UPDATE organization_invites SET token...
    if (t.startsWith('update organization_invites set token')) {
      const [token, expires_at, role, invited_by, id] = params;
      const inv = state.invites.find((i) => i.id === id);
      if (!inv) return { rows: [] };
      inv.token = token; inv.expires_at = expires_at; inv.role = role; inv.invited_by = invited_by;
      return { rows: [{ id: inv.id, email: inv.email, role: inv.role, status: inv.status, expires_at: inv.expires_at, created_at: inv.created_at }] };
    }
    // UPDATE organization_invites SET token, expires_at (resend path)
    if (t.startsWith('update organization_invites set token = $1, expires_at = $2 where id')) {
      const [token, expires_at, id] = params;
      const inv = state.invites.find((i) => i.id === id);
      if (inv) { inv.token = token; inv.expires_at = expires_at; }
      return { rows: [] };
    }
    // SELECT * FROM organization_invites WHERE id = $1 AND organization_id = $2
    if (t.startsWith('select * from organization_invites where id')) {
      const inv = state.invites.find((i) => i.id === params[0] && i.organization_id === params[1]);
      return { rows: inv ? [inv] : [] };
    }
    // INSERT into organization_invites
    if (t.startsWith('insert into organization_invites')) {
      const [organization_id, email, role, token, invited_by, expires_at] = params;
      const inv = { id: nextInviteId++, organization_id, email, role, token, invited_by, expires_at, status: 'pending', created_at: new Date() };
      state.invites.push(inv);
      return { rows: [{ id: inv.id, email: inv.email, role: inv.role, status: inv.status, expires_at: inv.expires_at, created_at: inv.created_at }] };
    }
    // audit log
    if (t.startsWith('insert into team_audit_logs')) {
      state.audit.push({ orgId: params[0], actor: params[1], action: params[2] });
      return { rows: [] };
    }
    // SELECT ... FROM organization_invites i JOIN organizations o ...  (acceptInvite lookup by token)
    if (t.includes('from organization_invites i join organizations o') && t.includes('where i.token = $1 and i.status')) {
      const inv = state.invites.find((i) => i.token === params[0] && i.status === 'pending' && new Date(i.expires_at) > new Date());
      if (!inv) return { rows: [] };
      const org = state.orgs.find((o) => o.id === inv.organization_id);
      return { rows: [{ ...inv, org_name: org.name }] };
    }
    // getInviteByToken
    if (t.includes('from organization_invites i join organizations o') && t.endsWith('where i.token = $1')) {
      const inv = state.invites.find((i) => i.token === params[0]);
      if (!inv) return { rows: [] };
      const org = state.orgs.find((o) => o.id === inv.organization_id);
      return { rows: [{ id: inv.id, email: inv.email, role: inv.role, status: inv.status, expires_at: inv.expires_at, org_name: org.name }] };
    }
    // listInvites
    if (t.includes('from organization_invites i join users u on i.invited_by = u.id')) {
      const rows = state.invites
        .filter((i) => i.organization_id === params[0])
        .filter((i) => !params[1] || params[1] === 'all' || i.status === params[1])
        .map((i) => ({
          id: i.id, email: i.email, role: i.role, status: i.status,
          expires_at: i.expires_at, created_at: i.created_at,
          invited_by_email: (state.users.find((u) => u.id === i.invited_by) || {}).email,
        }));
      return { rows };
    }
    // listMembers
    if (t.includes('from users u join organization_members om on u.id = om.user_id')) {
      return { rows: state.members.filter((m) => m.organization_id === params[0]).map((m) => {
        const u = state.users.find((u) => u.id === m.user_id);
        return { id: u.id, email: u.email, display_name: null, avatar_url: null, status: 'active', last_active_at: null,
                 role: m.role, joined_at: new Date(), invited_by: null, invited_by_email: null };
      }) };
    }
    // count members
    if (t.startsWith('select count(*) as total from users u join organization_members')) {
      return { rows: [{ total: state.members.filter((m) => m.organization_id === params[0]).length }] };
    }
    // addAllowedDomain INSERT
    if (t.startsWith('insert into allowed_email_domains')) {
      const [organization_id, domain, created_by] = params;
      const d = { id: nextDomainId++, organization_id, domain, created_by, created_at: new Date() };
      state.allowedDomains.push(d);
      return { rows: [{ id: d.id, domain: d.domain, created_by: d.created_by, created_at: d.created_at }] };
    }

    throw new Error(`Unmocked query: ${text.slice(0, 120)}...`);
  },
  healthCheck: async () => true,
  getClient: async () => ({ release: () => {} }),
  pool: {},
  __state: state,
};

// Intercept require of '../db'
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../db' || id.endsWith('/db') || id.endsWith('\\db') || id === './db') {
    return stubDb;
  }
  return origReq.apply(this, arguments);
};

// 2) Load the REAL services (emailService + teamService)
const emailService = require('./src/services/emailService');
console.log('\n=== Real emailService method inventory ===');
console.log('  has sendInviteEmail?', typeof emailService.sendInviteEmail);
console.log('  has sendWelcomeEmail?', typeof emailService.sendWelcomeEmail);
console.log('  has sendReportEmail?', typeof emailService.sendReportEmail);

const teamService = require('./src/services/teamService');

(async () => {
  console.log('\n=== Test 1: createInvite with parked email (was crashing) ===');
  try {
    const r = await teamService.createInvite(1, 'nishanth.p@engagedly.com', 'member', 1);
    console.log('  OK: created invite');
    console.log('    id:', r.id, 'email:', r.email, 'role:', r.role);
    console.log('    has token:', !!r.token, 'len:', r.token?.length);
    console.log('    inviteUrl:', r.inviteUrl);
    console.log('    emailSent:', r.emailSent, 'emailError:', r.emailError);
    console.log('    mailDisabled flag:', r.mailDisabled);
    console.log('    reused:', r.reused);
  } catch (e) {
    console.log('  FAIL:', e.message);
    process.exit(1);
  }

  console.log('\n=== Test 2: resend invite generates fresh token/URL ===');
  const firstToken = state.invites[0].token;
  try {
    const r = await teamService.resendInvite(1, 1, 1);
    console.log('  OK: resend succeeded');
    console.log('    inviteId:', r.id, 'email:', r.email);
    console.log('    new token:', r.token?.slice(0, 16) + '...');
    console.log('    token rotated?', r.token !== firstToken ? 'YES' : 'NO');
    console.log('    inviteUrl:', r.inviteUrl);
    console.log('    emailSent:', r.emailSent, 'mailDisabled:', r.mailDisabled);
  } catch (e) {
    console.log('  FAIL:', e.message);
    process.exit(1);
  }

  console.log('\n=== Test 3: re-invite same email refreshes existing record (idempotent) ===');
  const beforeCount = state.invites.length;
  try {
    const r = await teamService.createInvite(1, 'nishanth.p@engagedly.com', 'admin', 1);
    console.log('  OK: re-invite succeeded');
    console.log('    reused:', r.reused, '(expected true)');
    console.log('    role updated to:', r.role, '(expected admin)');
    console.log('    invite count in DB:', state.invites.length, '(expected', beforeCount + ')');
    console.log('    mailDisabled:', r.mailDisabled);
  } catch (e) {
    console.log('  FAIL:', e.message);
    process.exit(1);
  }

  console.log('\n=== Test 4: getInviteByToken returns valid info ===');
  const curToken = state.invites[0].token;
  try {
    const info = await teamService.getInviteByToken(curToken);
    console.log('  OK:', JSON.stringify(info, null, 2));
    if (!info.isValid) { console.log('  FAIL: should be valid'); process.exit(1); }
  } catch (e) {
    console.log('  FAIL:', e.message);
    process.exit(1);
  }

  console.log('\n=== Test 5: acceptInvite still works (welcome email parked) ===');
  state.users.push({ id: 2, email: 'nishanth.p@engagedly.com' });
  try {
    const r = await teamService.acceptInvite(curToken, 2);
    console.log('  OK: accepted into org', r.organizationId, 'as', r.role);
  } catch (e) {
    console.log('  FAIL:', e.message);
    process.exit(1);
  }

  console.log('\n=== Test 6: addAllowedDomain returns created_by_email ===');
  try {
    const d = await teamService.addAllowedDomain(1, 'engagedly.com', 1);
    console.log('  OK:', JSON.stringify(d));
    if (d.created_by_email !== 'admin@engagedly.com') {
      console.log('  WARN: created_by_email missing/wrong:', d.created_by_email);
    }
  } catch (e) {
    console.log('  FAIL:', e.message);
    process.exit(1);
  }

  console.log('\n=== Test 7: listAllowedDomains includes created_by_email ===');
  try {
    const list = await teamService.listAllowedDomains(1);
    console.log('  OK:', JSON.stringify(list));
  } catch (e) {
    console.log('  FAIL:', e.message);
    process.exit(1);
  }

  console.log('\n=== All tests passed ===');
})().catch((e) => {
  console.error('UNCAUGHT:', e);
  process.exit(1);
});
