-- Migration 006: Team Management & RBAC
-- Organizations, memberships, invites, domain restrictions, audit logs

-- 1. Organizations table
CREATE TABLE IF NOT EXISTS organizations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  domain TEXT UNIQUE,  -- e.g., 'engagedly.com' for auto-matching
  logo_url TEXT,
  settings JSONB DEFAULT '{}',
  domain_restriction_enabled BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_organizations_domain ON organizations(domain);

-- 2. Allowed email domains (for domain restriction)
CREATE TABLE IF NOT EXISTS allowed_email_domains (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, domain)
);

CREATE INDEX IF NOT EXISTS idx_allowed_email_domains_org ON allowed_email_domains(organization_id);

-- 3. Add organization_id to users table
ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL;
ALTER TABLE users ADD COLUMN IF NOT EXISTS display_name TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deactivated', 'pending'));
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_by INTEGER REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_organization ON users(organization_id);
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

-- 4. Organization members (role assignment)
CREATE TABLE IF NOT EXISTS organization_members (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member', 'viewer')),
  invited_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(organization_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_org_members_org ON organization_members(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);
CREATE INDEX IF NOT EXISTS idx_org_members_role ON organization_members(role);

-- 5. Organization invites
CREATE TABLE IF NOT EXISTS organization_invites (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member', 'viewer')),
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'expired', 'revoked')),
  invited_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_org_invites_org ON organization_invites(organization_id);
CREATE INDEX IF NOT EXISTS idx_org_invites_email ON organization_invites(email);
CREATE INDEX IF NOT EXISTS idx_org_invites_token ON organization_invites(token);
CREATE INDEX IF NOT EXISTS idx_org_invites_status ON organization_invites(status);

-- 6. Team audit log
CREATE TABLE IF NOT EXISTS team_audit_logs (
  id SERIAL PRIMARY KEY,
  organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,  -- 'invite_sent', 'invite_accepted', 'member_removed', 'role_changed', etc.
  target_type TEXT,      -- 'user', 'invite', 'domain', 'organization'
  target_id TEXT,        -- ID of the affected entity
  details JSONB DEFAULT '{}',
  ip_address TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_team_audit_logs_org ON team_audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_team_audit_logs_actor ON team_audit_logs(actor_id);
CREATE INDEX IF NOT EXISTS idx_team_audit_logs_action ON team_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_team_audit_logs_created ON team_audit_logs(created_at DESC);

-- 7. Update triggers
DROP TRIGGER IF EXISTS trg_organizations_updated_at ON organizations;
CREATE TRIGGER trg_organizations_updated_at
  BEFORE UPDATE ON organizations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_org_members_updated_at ON organization_members;
CREATE TRIGGER trg_org_members_updated_at
  BEFORE UPDATE ON organization_members
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

DROP TRIGGER IF EXISTS trg_org_invites_updated_at ON organization_invites;
CREATE TRIGGER trg_org_invites_updated_at
  BEFORE UPDATE ON organization_invites
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- 8. Helper function to check if user has required role
CREATE OR REPLACE FUNCTION user_has_org_role(p_user_id INTEGER, p_org_id INTEGER, p_required_roles TEXT[])
RETURNS BOOLEAN AS $$
DECLARE
  v_role TEXT;
BEGIN
  SELECT role INTO v_role
  FROM organization_members
  WHERE user_id = p_user_id AND organization_id = p_org_id;
  
  RETURN v_role = ANY(p_required_roles);
END;
$$ LANGUAGE plpgsql;

-- Down Migration
-- DROP FUNCTION IF EXISTS user_has_org_role;
-- DROP TABLE IF EXISTS team_audit_logs;
-- DROP TABLE IF EXISTS organization_invites;
-- DROP TABLE IF EXISTS organization_members;
-- DROP TABLE IF EXISTS allowed_email_domains;
-- ALTER TABLE users DROP COLUMN IF EXISTS organization_id;
-- ALTER TABLE users DROP COLUMN IF EXISTS display_name;
-- ALTER TABLE users DROP COLUMN IF EXISTS avatar_url;
-- ALTER TABLE users DROP COLUMN IF EXISTS status;
-- ALTER TABLE users DROP COLUMN IF EXISTS deactivated_at;
-- ALTER TABLE users DROP COLUMN IF EXISTS deactivated_by;
-- ALTER TABLE users DROP COLUMN IF EXISTS last_active_at;
-- DROP TABLE IF EXISTS organizations;
