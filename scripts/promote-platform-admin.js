#!/usr/bin/env node
/**
 * Platform admin maintenance:
 *   node scripts/promote-platform-admin.js <email>                       Grant platform admin
 *   node scripts/promote-platform-admin.js --revoke <email>              Revoke platform admin
 *   node scripts/promote-platform-admin.js --list                        List current admins
 *   node scripts/promote-platform-admin.js --reset-password <email> [pw] Reset a user's password
 *                                                                       (auto-generates one if pw is omitted)
 *
 * Idempotent. Exits non-zero if the email isn't found.
 * Reset-password also revokes all active refresh tokens for that user so any
 * existing session can't survive the rotation.
 */
require('dotenv').config();
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('../src/db');

function generatePassword() {
  // 16 url-safe chars; mixes letters + digits so it satisfies the register
  // schema (must contain at least one letter AND one number).
  const buf = crypto.randomBytes(12).toString('base64url');
  return `${buf}9a`.slice(0, 16);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    console.log('Usage:');
    console.log('  promote-platform-admin.js <email>                          Grant platform admin');
    console.log('  promote-platform-admin.js --revoke <email>                 Revoke platform admin');
    console.log('  promote-platform-admin.js --list                           List current admins');
    console.log('  promote-platform-admin.js --reset-password <email> [pw]    Reset password (auto-generates if omitted)');
    process.exit(args.length === 0 ? 1 : 0);
  }

  if (args[0] === '--reset-password') {
    const email = (args[1] || '').toLowerCase().trim();
    if (!email) { console.error('Email required: --reset-password <email> [newPassword]'); process.exit(1); }
    const user = await db.query('SELECT id, email FROM users WHERE LOWER(email) = $1', [email]);
    if (!user.rows.length) { console.error(`No user with email ${email}`); process.exit(2); }
    const provided = args[2];
    const newPw = provided || generatePassword();
    if (provided && (provided.length < 8 || !/[a-zA-Z]/.test(provided) || !/[0-9]/.test(provided))) {
      console.error('Password must be at least 8 chars and contain a letter and a number.');
      process.exit(1);
    }
    const hash = await bcrypt.hash(newPw, 12);
    await db.query('UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, user.rows[0].id]);
    // Kill existing sessions so the old password can't be replayed via a
    // still-valid refresh cookie.
    const revoked = await db.query('DELETE FROM refresh_tokens WHERE user_id = $1', [user.rows[0].id]);
    console.log(`Password reset for ${email} (user #${user.rows[0].id})`);
    console.log(`Revoked ${revoked.rowCount} active refresh token(s).`);
    if (!provided) {
      console.log('');
      console.log(`  New password: ${newPw}`);
      console.log('  ↑ share this securely; it was auto-generated and is not stored anywhere else.');
    } else {
      console.log('  New password set to the value you provided.');
    }
    process.exit(0);
  }

  if (args[0] === '--list') {
    const r = await db.query(
      `SELECT id, email, organization_id, created_at
         FROM users WHERE is_platform_admin = true ORDER BY id`
    );
    if (!r.rows.length) console.log('(no platform admins)');
    else r.rows.forEach((u) => console.log(`#${u.id}  ${u.email}  org=${u.organization_id}`));
    process.exit(0);
  }

  const revoke = args[0] === '--revoke';
  const email = (revoke ? args[1] : args[0] || '').toLowerCase().trim();
  if (!email) { console.error('Email required'); process.exit(1); }

  const user = await db.query('SELECT id, email, is_platform_admin FROM users WHERE LOWER(email) = $1', [email]);
  if (!user.rows.length) { console.error(`No user with email ${email}`); process.exit(2); }

  const target = !revoke;
  if (user.rows[0].is_platform_admin === target) {
    console.log(`User ${email} is already ${target ? 'a platform admin' : 'not a platform admin'} — nothing to do`);
    process.exit(0);
  }

  await db.query('UPDATE users SET is_platform_admin = $1, updated_at = NOW() WHERE id = $2', [target, user.rows[0].id]);
  console.log(`${target ? 'Granted' : 'Revoked'} platform admin for ${email} (user #${user.rows[0].id})`);
  console.log('Note: existing JWT tokens stay in effect until they expire. Have the user log out + log in to refresh.');
  process.exit(0);
}

main().catch((err) => { console.error(err); process.exit(1); });
