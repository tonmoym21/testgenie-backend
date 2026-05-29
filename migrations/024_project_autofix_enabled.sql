-- Per-project "autofix is enabled at all" toggle.
--
-- PR #32 introduced daily_limit overrides. That covers "this tenant
-- gets a higher cap than the env default," but it doesn't cover the
-- distinct case "disable autofix entirely for this tenant" cleanly:
--   - Setting daily_limit = 0 works but conflates "disabled" with
--     "out of quota" — the error message ("daily limit reached
--     0/0 attempts") makes no sense, and the operator can't tell
--     by reading the row whether the project is paused or just at
--     the cap.
--   - It also stops them from later setting a real limit while keeping
--     the autofix off (e.g. "we'll enable it next quarter with a 50/day cap").
--
-- A dedicated boolean column is the right shape. DEFAULT TRUE
-- preserves existing-row behavior; NOT NULL because absence is
-- meaningless (every row is one of "active" or "paused"). Combined
-- with the resolver's LEFT JOIN + COALESCE(enabled, TRUE), projects
-- without a config row at all stay enabled (= current behavior).

ALTER TABLE project_autofix_configs
  ADD COLUMN enabled BOOLEAN NOT NULL DEFAULT TRUE;
