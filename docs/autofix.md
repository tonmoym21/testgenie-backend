# Auto-fix loop — operator runbook

End-to-end flow:

```
Playwright run
   └─► writeRunLineage  ──►  test_failures  (fix_status='open')
                                    │
                                    ▼
                              proposeFix       (LLM patches the spec)
                                    │
                                    ▼
                             fix_attempts      (status='proposed')
                                    │
                                    ▼
                               applyFix        (real git commit on agent branch)
                                    │
                                    ▼
                             fix_attempts      (status='pr_opened' if --open-pr)
                                    │
                                    ▼
                              verifyFix        (real `npx playwright test`)
                                    │
                                    ▼
                  verified ─────────┼──────── verify_failed
                       │                            │
                       ▼                            ▼
            (PR review + merge)          test_failures back to 'open'
                       │                  (retry can re-claim)
                       ▼
              GitHub webhook
                       │
                       ▼
                  markMerged
                       │
                       ▼
               fix_attempts      (status='merged')
               test_failures     (fix_status='resolved')
```

Each stage is a separate CLI you can drive by hand. The loop is glue, not magic.

---

## Quick demo (90 seconds, no API spend, no real browser)

```bash
npm run db:bootstrap           # one-time: migrations against TEST_DB_URL
node scripts/demo-loop.js
```

Seeds rows, writes a synthetic Playwright report, simulates the LLM patch, forks a real temp git repo, applies the patch, runs a stubbed verify, and marks merged. End-to-end against real Postgres + real git.

Stage 7 (`verifyFix`) is stubbed in the demo because the temp repo has no `@playwright/test` installed — see [Real end-to-end](#real-end-to-end-with-a-customer-repo) below for the unstubbed path.

Flags:
- `--keep` — leave the temp git repo on disk for inspection
- `--push` — push the agent branch to a bare repo created in the temp dir
- `--open-pr` — run `gh pr create` (requires `gh auth` and a real remote)

---

## Real end-to-end with a customer repo

The demo loop's only fake is the Playwright spawn. To run it for real:

```bash
# 1. propose: LLM reads a test_failures row and writes a fix_attempts row
node scripts/autofix.js <failureId>

# 2. apply: commit the patch on an agent branch in a real checkout
node scripts/autofix-apply.js <fixAttemptId> --repo /path/to/customer/repo --open-pr

# 3. verify: run `npx playwright test` against the agent branch for real
node scripts/autofix-verify.js <fixAttemptId> --repo /path/to/customer/repo
```

Or pre-register the repo per-project so you don't have to pass `--repo` on every call (see [Per-project repo configs](#per-project-repo-configs)).

The verify step shells out to `npx playwright test <spec> --reporter=line --retries=0`. The customer repo must have `@playwright/test` installed and at least one browser provisioned (`npx playwright install chromium`). `--retries=0` is deliberate — a flake-pass must not count as a real fix.

---

## GitHub webhook setup

Closes the loop. When the auto-fix PR merges on GitHub, the webhook flips `fix_attempts.status` → `merged` and `test_failures.fix_status` → `resolved` so a future run won't re-propose the same fix.

**Register at:** `Settings → Webhooks → Add webhook` on the customer's GitHub repo (or org, if you want one secret for many repos).

| Field | Value |
|---|---|
| Payload URL | `https://<your-backend>/api/webhooks/github` |
| Content type | `application/json` |
| Secret | A 32+ byte random string — also set as `GITHUB_WEBHOOK_SECRET` on the backend |
| Events | **Pull requests** only (the handler ignores everything else with a 200 noop) |
| Active | ✅ |

**Required env on the backend:**

```bash
GITHUB_WEBHOOK_SECRET=<same string you pasted into GitHub>
```

If unset, the route returns 503 — fail-closed by design. Verify with `curl -i .../api/webhooks/github` (no signature → 503).

**How the handler scopes per project:** the `pull_request.base.repo.full_name` (e.g. `acme/checkout`) is matched against `project_repo_configs.github_repo` so multi-tenant deployments don't cross-mark fixes from other projects. If no row matches, the handler still acts on the `branch_name` lookup but logs a warning.

---

## LLM provider configuration

`AUTOFIX_PROVIDER` selects which backend `proposeFix` calls. Both providers honour `AUTOFIX_MODEL`.

### OpenAI (default)

```bash
AUTOFIX_PROVIDER=openai        # or unset — openai is the default
OPENAI_API_KEY=sk-...
AUTOFIX_MODEL=gpt-4o           # optional; default is gpt-4o
```

### OpenAI-compatible (BYO key, Azure, custom proxies, vLLM, Together, etc.)

Same provider, just point the SDK elsewhere:

```bash
AUTOFIX_PROVIDER=openai
OPENAI_API_KEY=<whatever-the-backend-wants>
OPENAI_BASE_URL=https://openai-proxy.acme.internal/v1
AUTOFIX_MODEL=<model-name-on-that-backend>
```

### Ollama (local, no API spend)

```bash
AUTOFIX_PROVIDER=ollama
OLLAMA_BASE_URL=http://localhost:11434     # optional; default
AUTOFIX_MODEL=llama3.1                      # optional; default
```

---

## Per-project repo configs

So `autofix-apply.js` / `autofix-verify.js` / the webhook don't need `--repo` passed on every call, register the repo once per project in `project_repo_configs`:

```sql
INSERT INTO project_repo_configs
  (project_id, repo_path,         github_repo,    spec_dir,         default_base_branch)
VALUES
  ($1,         '/srv/repos/acme', 'acme/checkout','tests/e2e',      'main');
```

Fields:
- `repo_path` — absolute path on the backend host for the checkout `applyFix` / `verifyFix` will operate on
- `github_repo` — `owner/name` GitHub identifier; the webhook handler uses this for tenant scoping
- `spec_dir` — where Playwright specs live, relative to `repo_path` (default `tests`)
- `default_base_branch` — base branch for `git diff` and PR base (default `main`)

When both an explicit CLI flag (`--repo`) and a config row are present, the CLI flag wins.

---

## Environment variable reference

| Var | Required | Default | Used by |
|---|---|---|---|
| `DATABASE_URL` | yes | — | everything |
| `JWT_SECRET` | yes | — | auth |
| `OPENAI_API_KEY` | conditional — see note | — | `analyzeService`, `playwrightGenerator`, `scenarioGenerator`, `proposeFix` when `AUTOFIX_PROVIDER=openai` |
| `AUTOFIX_PROVIDER` | no | `openai` | `proposeFix` |
| `AUTOFIX_MODEL` | no | `gpt-4o` (openai) / `llama3.1` (ollama) | `proposeFix` |
| `OPENAI_BASE_URL` | no | `api.openai.com` | OpenAI provider — overrides for BYO endpoints |
| `OLLAMA_BASE_URL` | no | `http://localhost:11434` | Ollama provider |
| `GITHUB_WEBHOOK_SECRET` | yes (for webhook) | — | `/api/webhooks/github` |
| `TEST_DB_URL` | for integration tests | `postgresql://postgres:postgres@localhost:5432/testforge_test` | `*.integration.test.js`, `db:bootstrap` |
| `RUN_PLAYWRIGHT_TESTS` | no | unset | gates `autoFixVerifyService.realPlaywright.integration.test.js` |

Note on `OPENAI_API_KEY` for Ollama-only setups:

- `AUTOFIX_PROVIDER=ollama` makes `OPENAI_API_KEY` optional at boot.
- All four OpenAI call sites (analyzeService, playwrightGenerator, scenarioGenerator, the OpenAI LLM provider) now lazy-construct via `src/services/llm/openaiClient.js`. With no key set, the affected routes return **HTTP 503 `FEATURE_UNAVAILABLE`** with a message naming the feature and pointing at this knob — no 500s, no boot failures.
- The auto-fix path (`proposeFix` + the OpenAI provider) is doubly safe: lazy-constructed AND never reached when `AUTOFIX_PROVIDER=ollama`.

Recipes:
- **Auto-fix only, no OpenAI features wanted:** set `AUTOFIX_PROVIDER=ollama` and leave `OPENAI_API_KEY` unset. `/api/analyze`, scenario generation, and spec generation will respond 503 `FEATURE_UNAVAILABLE`. The auto-fix loop runs entirely against Ollama.
- **Mixed (Ollama for auto-fix, OpenAI for analyze/generators):** set both `AUTOFIX_PROVIDER=ollama` and `OPENAI_API_KEY=sk-...`. All features work.
- **Default:** `AUTOFIX_PROVIDER` unset (= 'openai'), `OPENAI_API_KEY=sk-...`. Unchanged from before this branch.

---

## Common operator commands

```bash
# What failures are currently open / proposed / verified?
node scripts/list-failures.js

# Propose a fix for one failure
node scripts/autofix.js 42

# Apply (real git, no push)
node scripts/autofix-apply.js 17 --repo /srv/repos/acme

# Apply + push + open PR
node scripts/autofix-apply.js 17 --repo /srv/repos/acme --open-pr

# Verify against the agent branch (real Playwright)
node scripts/autofix-verify.js 17 --repo /srv/repos/acme
```

All four are CLI wrappers around the same services the cron / webhook drive. Anything you can do automatically you can do by hand on the same data.
