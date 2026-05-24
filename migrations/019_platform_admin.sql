-- Migration 019: Platform admin + org status/features + cross-org audit
-- Adds:
--   - users.is_platform_admin           — bootstraps the cross-org admin role
--   - organizations.status              — active | suspended | deleted (soft)
--   - organizations.suspended_at/_reason
--   - organizations.features JSONB      — per-org feature toggles
--   - platform_audit_logs               — separate from team_audit_logs so
--                                         cross-org actions don't pollute
--                                         per-org audit views.

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS idx_users_platform_admin ON users(is_platform_admin) WHERE is_platform_admin = true;

ALTER TABLE organizations ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
  CHECK (status IN ('active', 'suspended', 'deleted'));
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS suspension_reason TEXT;
ALTER TABLE organizations ADD COLUMN IF NOT EXISTS features JSONB NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS idx_organizations_status ON organizations(status);

CREATE TABLE IF NOT EXISTS platform_audit_logs (
  id SERIAL PRIMARY KEY,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_email TEXT,
  action TEXT NOT NULL,
  target_type TEXT,
  target_id TEXT,
  target_org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  details JSONB DEFAULT '{}'::jsonb,
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_platform_audit_actor ON platform_audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_platform_audit_org ON platform_audit_logs(target_org_id);
CREATE INDEX IF NOT EXISTS idx_platform_audit_created ON platform_audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_audit_action ON platform_audit_logs(action);
