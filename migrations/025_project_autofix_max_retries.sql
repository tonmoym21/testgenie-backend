-- Per-project override for the per-failure retry cap (PR #25's
-- AUTOFIX_MAX_RETRIES_PER_FAILURE env var). Same shape as the
-- daily_limit override from migration 023: nullable INT, NULL means
-- "use env default."
--
-- Use case: a known-flaky-spec tenant might warrant more attempts
-- (the LLM has more chances to course-correct from prior error
-- messages); a high-trust low-flake tenant might want the cap
-- lower (give up faster, save quota). Today both are stuck with
-- one global value.
--
-- max_retries_per_failure=0 is legal in the env semantics ("cap
-- disabled, allow infinite retries") so the CHECK matches: >= 0.

ALTER TABLE project_autofix_configs
  ADD COLUMN max_retries_per_failure INTEGER,
  ADD CONSTRAINT project_autofix_configs_max_retries_nonneg
    CHECK (max_retries_per_failure IS NULL OR max_retries_per_failure >= 0);
