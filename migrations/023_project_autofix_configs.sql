-- Per-project autofix configuration overrides.
--
-- The autofix loop's tunables (daily_limit, eventually max_retries_per_failure,
-- enabled toggle, cron interval, etc.) have until now been global env vars
-- — AUTOFIX_DAILY_LIMIT applies to every project equally. That works for a
-- single-tenant deploy but breaks the moment you have a paying customer
-- on the same backend as a free-tier one: you can't give the paying tenant
-- a higher cap without raising the cap for everyone.
--
-- A separate table (not columns on `projects`) for two reasons:
--   1. Keeps autofix-specific schema noise out of the project table.
--      `projects` is hit by every dashboard query; widening it for an
--      optional subsystem is the wrong shape.
--   2. The autofix subsystem will accumulate more tunables over time
--      (retry cap, enabled flag, model override per project). Bolting
--      them onto `projects` one column at a time is migration debt; a
--      dedicated table lets new columns land here without touching
--      anything else.
--
-- Nullable daily_limit is deliberate: NULL means "use the env default,"
-- which preserves the existing behavior for every project that doesn't
-- explicitly opt in. proposeFix's resolver reads the override only when
-- the row exists AND daily_limit IS NOT NULL.

CREATE TABLE IF NOT EXISTS project_autofix_configs (
  project_id    INTEGER PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  daily_limit   INTEGER,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Guard against operationally-meaningless values. 0 to disable
  -- explicitly (mirrors AUTOFIX_DAILY_LIMIT=0 env semantics) is
  -- legal; negatives never are.
  CONSTRAINT project_autofix_configs_daily_limit_nonneg
    CHECK (daily_limit IS NULL OR daily_limit >= 0)
);
