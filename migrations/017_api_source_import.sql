-- API Source Management & Collection Automation
--
-- Three tables forming the import substrate:
--   api_sources         — a registered spec/file/paste (refreshable, versioned)
--   api_source_versions — content-addressed snapshots, one per (re-)fetch
--   api_endpoints       — parsed operations, the unit users pick to import
--
-- Designed protocol-agnostic from day one (REST today, GraphQL/gRPC/AsyncAPI
-- later) via the `protocol` discriminator and `schema_ir` JSONB payload —
-- adding a new source type does not require a migration.

CREATE TABLE IF NOT EXISTS api_sources (
  id                SERIAL PRIMARY KEY,
  user_id           INTEGER REFERENCES users(id) ON DELETE SET NULL,
  organization_id   INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  name              VARCHAR(300) NOT NULL,
  protocol          VARCHAR(40)  NOT NULL DEFAULT 'rest',     -- rest|graphql|grpc|asyncapi
  format            VARCHAR(40)  NOT NULL,                    -- openapi3|openapi2|postman21|curl|url_probe
  spec_version      VARCHAR(40),
  source_url        TEXT,                                     -- null for direct-upload/paste
  servers           JSONB NOT NULL DEFAULT '[]'::jsonb,       -- array of {url, description, variables}
  auth_schemes      JSONB NOT NULL DEFAULT '[]'::jsonb,
  refresh_policy    JSONB NOT NULL DEFAULT '{"mode":"manual"}'::jsonb,
  lifecycle_state   VARCHAR(20) NOT NULL DEFAULT 'active',    -- draft|active|archived
  provenance        JSONB NOT NULL DEFAULT '{}'::jsonb,       -- ingestion metadata
  endpoint_count    INTEGER NOT NULL DEFAULT 0,
  last_fetched_at   TIMESTAMPTZ,
  parsed_at         TIMESTAMPTZ,
  current_version_id INTEGER,                                 -- FK added after api_source_versions exists
  parent_source_id  INTEGER REFERENCES api_sources(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_sources_user ON api_sources(user_id);
CREATE INDEX IF NOT EXISTS idx_api_sources_org  ON api_sources(organization_id);
CREATE INDEX IF NOT EXISTS idx_api_sources_lifecycle ON api_sources(lifecycle_state) WHERE deleted_at IS NULL;

-- Versioned snapshot of each parse. Content-addressed so we can dedup and
-- diff cheaply, and so history survives accidental re-imports.
CREATE TABLE IF NOT EXISTS api_source_versions (
  id                SERIAL PRIMARY KEY,
  source_id         INTEGER NOT NULL REFERENCES api_sources(id) ON DELETE CASCADE,
  content_address  VARCHAR(80) NOT NULL,                      -- sha256 hex of raw spec
  raw_size_bytes    INTEGER,
  parser_version    VARCHAR(40),
  endpoint_count    INTEGER NOT NULL DEFAULT 0,
  change_summary    JSONB NOT NULL DEFAULT '{}'::jsonb,       -- {added:N, removed:N, modified:N}
  fetched_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  parsed_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_source_versions_source ON api_source_versions(source_id, fetched_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_source_versions_address ON api_source_versions(content_address);

-- Now that the versions table exists, close the FK on api_sources.
ALTER TABLE api_sources
  ADD CONSTRAINT fk_api_sources_current_version
  FOREIGN KEY (current_version_id) REFERENCES api_source_versions(id) ON DELETE SET NULL;

-- Parsed operations. organization_id is denormalized so common list queries
-- don't have to JOIN through api_sources — keeps the catalog snappy at scale.
CREATE TABLE IF NOT EXISTS api_endpoints (
  id                  SERIAL PRIMARY KEY,
  source_id           INTEGER NOT NULL REFERENCES api_sources(id) ON DELETE CASCADE,
  organization_id     INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
  protocol            VARCHAR(40) NOT NULL DEFAULT 'rest',
  operation_id        VARCHAR(300),                           -- spec-provided, may be null
  fingerprint         VARCHAR(80) NOT NULL,                   -- stable identity across renames
  method              VARCHAR(10) NOT NULL,                   -- GET|POST|PUT|PATCH|DELETE|...
  path                TEXT NOT NULL,                          -- /users/{id}
  summary             TEXT,
  description         TEXT,
  tags                JSONB NOT NULL DEFAULT '[]'::jsonb,
  auth_requirement    JSONB NOT NULL DEFAULT '[]'::jsonb,
  request_schema      JSONB NOT NULL DEFAULT '{}'::jsonb,     -- {params, headers, query, body}
  response_schema     JSONB NOT NULL DEFAULT '{}'::jsonb,
  sample_request      JSONB NOT NULL DEFAULT '{}'::jsonb,     -- {method, url, headers, body} ready for executor
  bindings            JSONB NOT NULL DEFAULT '{}'::jsonb,     -- server overrides, per-endpoint base url
  examples            JSONB NOT NULL DEFAULT '[]'::jsonb,
  vendor_extensions   JSONB NOT NULL DEFAULT '{}'::jsonb,     -- x-* fields preserved for future use
  stability           VARCHAR(20) NOT NULL DEFAULT 'stable',  -- experimental|stable|deprecated
  first_seen_version_id INTEGER REFERENCES api_source_versions(id) ON DELETE SET NULL,
  last_seen_version_id  INTEGER REFERENCES api_source_versions(id) ON DELETE SET NULL,
  deprecated_at       TIMESTAMPTZ,
  removed_at          TIMESTAMPTZ,                             -- soft-delete tombstone
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_api_endpoints_source ON api_endpoints(source_id);
CREATE INDEX IF NOT EXISTS idx_api_endpoints_org    ON api_endpoints(organization_id);
CREATE INDEX IF NOT EXISTS idx_api_endpoints_fp     ON api_endpoints(fingerprint);
CREATE INDEX IF NOT EXISTS idx_api_endpoints_method ON api_endpoints(method);
CREATE INDEX IF NOT EXISTS idx_api_endpoints_active ON api_endpoints(source_id) WHERE removed_at IS NULL;

-- Trigram-ish search support without a contrib extension: a generated tsvector
-- across the searchable fields. Kept as an expression index, not a stored
-- column, so we don't fail on Postgres versions that disallow generated cols.
CREATE INDEX IF NOT EXISTS idx_api_endpoints_search
  ON api_endpoints USING gin (
    to_tsvector('simple', coalesce(path,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(operation_id,''))
  );
