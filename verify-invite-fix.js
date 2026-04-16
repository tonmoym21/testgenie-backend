// Standalone verifier that can be run from ANY directory.
// Copy this file to testgenie-backend/testgenie-backend/ and run:
//   node verify-invite-fix.js
//
// It monkey-patches the DB module in-memory so no real Postgres is needed.

'use strict';
const path = require('path');
const Module = require('module');

const state = {
  invites: [],
  orgs: [{ id: 1, name: 'Engagedly', domain: 'engagedly.com', domain_restriction_enabled: false, logo_url: null, settings: {} }],
  members: [{ organization_id: 1, user_id: 1, role: 'owner' }],
  users: [{ id: 1, email: 'admin@engagedly.com' }],
  allowedDomains: [],
};
let nextInviteId = 1;
let nextDomainId = 1;

const stubDb = {
  query: async (text, params = []) => {
    const t = text.replace(/\s+/g, ' ').trim().toLowerCase();

    if (t.startsWith('select id, name, domain, logo_url')) {
      const org = state.orgs.find((o) => o.id === params[0]);
      return { rows: org ? [org] : [] };
    }
    if (t.startsWith('select domain from allowed_email_domains')) {
      return { rows: state.allowedDomains.filter((d) => d.organization_id === params[0]) };
    }
    if (t.includes('from allowed_email_domains d') && t.startsWith('select d.id')) {
      return { rows: state.allowedDomains.filter((d) => d.organization_id === params[0])
        .map((d) => ({ ...d, created_by_email: (state.users.find((u) => u.id === d.created_by) || {}).email || null })) };
    }
    if (t.includes('left join organization_members om on u.id = om.user_id and om.organization_id')) {
      const user = state.users.find((u) => u.email === params[1]);
      if (!user) return { rows: [] };
      const m = state.members.find((m) => m.user_id === user.id && m.organization_id === params[0]);
      return { rows: [{ id: user.id, membership_id: m ? 'x' : null }] };
    }
    if (t.startsWith('select email from users where id')) {
      const u = state.users.find((u) => u.id === params[0]);
      return { rows: u ? [{ email: u.email }] : [] };
    }
    if (t.startsWith('select id, role from organization_invites')) {
      const matched = state.invites.filter((i) =>
        i.organization_id === params[0] &&
        i.email.toLowerCase() === params[1].toLowerCase() &&
        i.status === 'pending'
      );
      matched.sort((a, b) => b.created_at - a.created_at);
      return { rows: matched.slice(0, 1).map((i) => ({ id: i.id, role: i.role })) };
    }
    if (t.startsWith('update organization_invites set token = $1, expires_at = $2, role')) {
      const [token, expires_at, role, invited_by, id] = params;
      const inv = state.invites.find((i) => i.id === id);
      if (!inv) return { rows: [] };
      inv.token = token; inv.expires_at = expires_at; inv.role = role; inv.invited_by = invited_by;
      return { rows: [{ id: inv.id, email: inv.email, role: inv.role, status: inv.status, expires_at: inv.expires_at, created_at: inv.created_at }] };
    }
    if (t.startsWith('update organization_invites set token = $1, expires_at = $2 where id')) {
      const [token, expires_at, id] = params;
      const inv = state.invites.find((i) => i.id === id);
      if (inv) { inv.token = token; inv.expires_at = expires_at; }
      return { rows: [] };
    }
    if (t.startsWith('select * from organization_invites where id')) {
      const inv = state.invites.find((i) => i.id === params[0] && i.organization_id === params[1]);
      return { rows: inv ? [inv] : [] };
    }
    if (t.startsWith('insert into organization_invites')) {
      const [organization_id, email, role, token, invited_by, expires_at] = params;
      const inv = { id: nextInviteId++, organization_id, email, role, token, invited_by, expires_at, status: 'pending', created_at: new Date() };
      state.invites.push(inv);
      return { rows: [{ id: inv.id, email: inv.email, role: inv.role, status: inv.status, expires_at: inv.expires_at, created_at: inv.created_at }] };
    }
    if (t.startsWith('insert into team_audit_logs')) return { rows: [] };
    if (t.includes('from organization_invites i join organizations o') && t.includes('where i.token = $1 and i.status')) {
      const inv = state.invites.find((i) => i.token === params[0] && i.status === 'pending' && new Date(i.expires_at) > new Date());
      if (!inv) return { rows: [] };
      const org = state.orgs.find((o) => o.id === inv.organization_id);
      return { rows: [{ ...inv, org_name: org.name }] };
    }
    if (t.includes('from organization_invites i join organizations o')) {
      const inv = state.invites.find((i) => i.token === params[0]);
      if (!inv) return { rows: [] };
      const org = state.orgs.find((o) => o.id === inv.organization_id);
      return { rows: [{ id: inv.id, email: inv.email, role: inv.role, status: inv.status, expires_at: inv.expires_at, org_name: org.name }] };
    }
    if (t.startsWith('insert into organization_members')) {
      const [organization_id, user_id, role, invited_by] = params;
      state.members.push({ organization_id, user_id, role, invited_by });
      return { rows: [] };
    }
    if (t.startsWith('update users set organization_id')) return { rows: [] };
    if (t.startsWith('update organization_invites set status = \'accepted\'')) {
      const inv = state.invites.find((i) => i.id === params[0]);
      if (inv) inv.status = 'accepted';
      return { rows: [] };
    }
    if (t.startsWith('insert into allowed_email_domains')) {
      const [organization_id, domain, created_by] = params;
      const d = { id: nextDomainId++, organization_id, domain, created_by, created_at: new Date() };
      state.allowedDomains.push(d);
      return { rows: [d] };
    }

    console.log('[stub] unmocked:', text.slice(0, 100));
    return { rows: [] };
  },
  healthCheck: async () => true,
  getClient: async () => ({ release: () => {} }),
  pool: {},
};

// Intercept require of '../db'
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === '../db' || id === './db' || /[\\/]db$/.test(id)) return stubDb;
  return origReq.apply(this, arguments);
};

// Load real services
const emailService = require('./src/services/emailService');
console.log('\nemailService has sendInviteEmail?', typeof emailService.sendInviteEmail);
console.log('emailService has sendWelcomeEmail?', typeof emailService.sendWelcomeEmail);

const teamService = require('./src/services/teamService');

(async () => {
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => {
    if (ok) { pass++; console.log('  PASS:', name, detail ? `-- ${detail}` : ''); }
    else { fail++; console.log('  FAIL:', name, detail ? `-- ${detail}` : ''); }
  };

  console.log('\n=== 1) createInvite with email parked (was crashing) ===');
  const r1 = await teamService.createInvite(1, 'nishanth.p@engagedly.com', 'member', 1);
  check('invite returned', !!r1);
  check('has id', !!r1.id);
  check('has token (64 hex)', r1.token && r1.token.length === 64);
  check('has inviteUrl starting /accept-invite?token=', r1.inviteUrl && r1.inviteUrl.startsWith('/accept-invite?token='));
  check('emailSent=false (parked)', r1.emailSent === false, `reason=${r1.emailError}`);
  check('mailDisabled=true', r1.mailDisabled === true);
  check('reused=false for first-time', r1.reused === false);

  console.log('\n=== 2) resend invite generates a FRESH token (rotating) ===');
  const firstToken = r1.token;
  const r2 = await teamService.resendInvite(1, r1.id, 1);
  check('resend returned', !!r2);
  check('token rotated', r2.token && r2.token !== firstToken);
  check('new inviteUrl present', r2.inviteUrl && r2.inviteUrl !== r1.inviteUrl);
  check('mailDisabled=true still', r2.mailDisabled === true);
  check('email still in response', r2.email === 'nishanth.p@engagedly.com');

  console.log('\n=== 3) Re-create invite for same email (idempotent, reused=true) ===');
  const before = state.invites.length;
  const r3 = await teamService.createInvite(1, 'nishanth.p@engagedly.com', 'admin', 1);
  check('re-create returned', !!r3);
  check('reused=true', r3.reused === true);
  check('role updated to admin', r3.role === 'admin');
  check('no duplicate DB row created', state.invites.length === before);
  check('token rotated again', r3.token !== r2.token);

  console.log('\n=== 4) getInviteByToken returns valid=true for current token ===');
  const info = await teamService.getInviteByToken(r3.token);
  check('has invite info', !!info);
  check('isValid=true', info.isValid === true);
  check('status=pending', info.status === 'pending');

  console.log('\n=== 5) acceptInvite works end-to-end (welcome email parked, no crash) ===');
  state.users.push({ id: 2, email: 'nishanth.p@engagedly.com' });
  const r5 = await teamService.acceptInvite(r3.token, 2);
  check('accept returned org info', !!r5 && r5.organizationId === 1);
  check('role propagated', r5.role === 'admin');

  console.log('\n=== 6) addAllowedDomain returns created_by_email for immediate UI display ===');
  const d = await teamService.addAllowedDomain(1, 'partner.com', 1);
  check('domain added', !!d.id);
  check('created_by_email attached', d.created_by_email === 'admin@engagedly.com', `got=${d.created_by_email}`);

  console.log('\n=== 7) listAllowedDomains includes created_by_email ===');
  const list = await teamService.listAllowedDomains(1);
  check('list has 1 entry', list.length === 1);
  check('created_by_email present in list', list[0].created_by_email === 'admin@engagedly.com');

  console.log('\n===========================================');
  console.log(`  ${pass} passed, ${fail} failed`);
  console.log('===========================================');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('UNCAUGHT', e); process.exit(1); });
