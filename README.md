# TestForge Backend

Node + Express API behind the TestForge multi-tenant SaaS test management
platform. Postgres on Supabase, deployed to Render at
`testgenie-backend-g9fu.onrender.com`.

For the bigger picture (three-component architecture, public signup flow,
domain-claim model, ops scripts), see the [workspace README](../../README.md).

## Prerequisites

- Node.js 20+
- PostgreSQL 16+
- OpenAI API key

## Quick Start

### Option A: Docker (recommended)

```bash
# 1. Set up environment
cp .env.example .env
# Edit .env: set JWT_SECRET and OPENAI_API_KEY

# 2. Generate a secure JWT secret
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# Paste the output into JWT_SECRET in .env

# 3. Start everything (Postgres + API with hot reload)
docker compose up -d

# 4. Verify
curl http://localhost:3000/health
```

### Option B: Local Node.js

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env with your DATABASE_URL, JWT_SECRET, and OPENAI_API_KEY

# 3. Create the database and run migrations
createdb testgenie
npm run migrate:up

# 4. Start the server
npm run dev
```

### Running Tests

```bash
# Start the test database
docker compose --profile test up -d db-test

# Install deps (if not done)
npm install

# Run tests
npm test

# With coverage
npm run test:coverage
```

## API Endpoints

### Health
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | No | Liveness + DB check |

### Auth
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/auth/register` | No | Create account. Returns `{kind:'autoJoined', user}` (immediate access) or `{kind:'pending', email}` (must verify). See "Public signup" below. |
| POST | `/api/auth/verify-email` | No | Redeem a single-use verification token from the email link. Returns tokens + sets cookie on success. |
| POST | `/api/auth/resend-verification` | No | Mint a fresh verification email for a pending signup. 1/min/user throttle. Quiet-success for unknown/verified emails (no enumeration). |
| POST | `/api/auth/login` | No | Get tokens. Rejects unverified users with `EMAIL_NOT_VERIFIED`. |
| POST | `/api/auth/refresh` | No | Rotate tokens. |
| POST | `/api/auth/logout` | Yes | Revoke refresh token. |

### Admin (cross-org for platform admins, scoped for org owners)
| Method | Path | Scope | Description |
|--------|------|-------|-------------|
| GET | `/api/admin/me` | Either | Returns live admin scope (`{type:'platform'}` or `{type:'org', orgId}`). |
| GET | `/api/admin/metrics` | Either | Counts. Scope-filtered. |
| GET, PATCH, DELETE | `/api/admin/organizations[/:id]` | Either (delete = platform only) | Org CRUD. Owners can only rename their own. |
| GET, PATCH, DELETE | `/api/admin/users[/:id]` | Either | User CRUD. Soft-delete. |
| POST | `/api/admin/users/:id/reset-password` | Either | Rate-limited via `adminMutationLimiter`. |
| GET | `/api/admin/audit` | Either | Cursor-paginated via `?before=<iso>`. UNION of platform + team logs. |
| POST | `/api/admin/impersonate/:userId` | Platform | 5-min TTL token; `isPlatformAdmin` always false in the minted JWT. |
| POST | `/api/admin/organizations/:id/enter` | Platform | 30-min TTL backdoor entry into any org. |

### Projects
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/projects` | Yes | List projects |
| GET | `/api/projects/:id` | Yes | Get project |
| POST | `/api/projects` | Yes | Create project |
| PATCH | `/api/projects/:id` | Yes | Update project |
| DELETE | `/api/projects/:id` | Yes | Delete project |

### Test Cases
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/projects/:pid/testcases` | Yes | List test cases |
| POST | `/api/projects/:pid/testcases` | Yes | Create test case |
| POST | `/api/projects/:pid/testcases/batch` | Yes | Batch create (up to 50) |
| PATCH | `/api/projects/:pid/testcases/:id` | Yes | Update test case |
| DELETE | `/api/projects/:pid/testcases/:id` | Yes | Delete test case |

### AI Analysis
| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/projects/:pid/analyze` | Yes | Run AI analysis |

Analysis types: `coverage_gaps`, `quality_review`, `risk_assessment`, `duplicate_detection`

## Public signup flow

`POST /api/auth/register` is multi-branched by design:

1. **First user ever** (no orgs in DB) → bootstrap a new org with the supplied `companyName` (or `'TestForge'` default), user becomes `owner`, email auto-verified. `kind:'autoJoined'`.
2. **Corporate email at a domain that matches an existing verified org** → auto-join as `member`, auto-verified, no email sent. `kind:'autoJoined'`.
3. **Corporate email at a new domain + `companyName` provided** → create a *pending* user + *pending* org (`verified_at = NULL`), mint a 32-byte single-use token, send verification email via Resend, return `kind:'pending'`. User must click the link before `/login` works.
4. **Consumer email** (gmail / outlook / yahoo / mailinator / …, see `src/utils/consumerEmailDomains.js`) → 403 `Please sign up with your work email`. Platform admins can override via `scripts/promote-platform-admin.js --create-admin`.

Domain claim is race-safe: a unique partial index on `organizations(LOWER(domain)) WHERE verified_at IS NOT NULL` ensures only the first verifier wins the domain. Subsequent same-domain pending signups get `Your company domain has already been claimed`.

Background `signupJanitor` sweeps pending users + orphan pending orgs >7 days old every 24h.

## Admin scripts

```bash
# Promote / demote / list platform admins
node scripts/promote-platform-admin.js <email>
node scripts/promote-platform-admin.js --revoke <email>
node scripts/promote-platform-admin.js --list

# Create a fresh platform admin (org-less, password auto-generated)
node scripts/promote-platform-admin.js --create-admin <email> [password]

# Reset a user's password (revokes all their refresh tokens too)
node scripts/promote-platform-admin.js --reset-password <email> [password]

# Mint a verification link for a pending signup, bypassing the email step
# Useful when Resend isn't configured or for E2E testing.
node scripts/promote-platform-admin.js --verify-link <email>
```

All scripts read `DATABASE_URL` from `.env`.

## Project Structure

```
src/
  index.js              App entry, middleware stack
  config.js             Env validation (zod)
  db.js                 PostgreSQL pool
  middleware/
    auth.js             JWT verification
    errorHandler.js     Centralized errors
    rateLimiter.js      Rate limit configs
    validate.js         Zod validation middleware
  routes/
    health.js           Health check
    auth.js             Auth endpoints
    projects.js         Project CRUD
    testcases.js        Test case CRUD + batch
    analyze.js          AI analysis
  services/
    authService.js      Auth logic + token rotation
    projectService.js   Project business logic
    testcaseService.js  Test case logic + bulk insert
    analyzeService.js   OpenAI integration + retry
  utils/
    apiError.js         Custom error classes
    logger.js           Pino logger
    retry.js            Exponential backoff
docker/
  init.sql              Docker-only DB init (idempotent)
migrations/
  1711756800000_initial-schema.sql
__tests__/
  setup.js              DB lifecycle + test helpers
  health.test.js        Health endpoint tests
  auth.test.js          Auth flow tests (12)
  projects.test.js      Project CRUD tests (10)
  testcases.test.js     Test case tests (16)
```

## Security

- Passwords hashed with bcrypt (cost 12)
- Short-lived access tokens (15m) with refresh rotation
- Refresh token stored in an HttpOnly `tg_refresh` cookie (not localStorage)
- All input validated with zod
- Parameterized SQL queries (no raw string interpolation)
- Rate limiting on auth (20/15min) and analysis (10/min)
- Helmet security headers
- CORS restricted to configured origin

### Auth cookie contract

`POST /api/auth/login` and `POST /api/auth/refresh` set a `tg_refresh` cookie:

| Attribute | Value |
|---|---|
| `HttpOnly` | yes (not accessible from JS) |
| `Path` | `/api/auth` (only sent to auth endpoints) |
| `SameSite` | `Lax` |
| `Secure` | yes when `NODE_ENV=production` |
| `Max-Age` | 2592000 (30 days) |

`POST /api/auth/logout` clears the cookie (`Max-Age=0`).

`/auth/refresh` and `/auth/logout` accept the token from the cookie OR a
`refreshToken` field in the body, in that order. The body path is kept for
backward compatibility but new clients should rely on the cookie.

### Required env config in production

| Var | Reason |
|---|---|
| `DATABASE_URL` | Postgres connection string (Supabase in prod). |
| `JWT_SECRET` | 32+ chars; rotating this invalidates every active session. |
| `CORS_ORIGIN` | **Must** be a concrete allow-list, never `*`. The cookie requires credentialed CORS, which forbids wildcard origins. Use a comma-separated list, e.g. `https://testforge-app.vercel.app,https://testforge-admin.vercel.app`. |
| `NODE_ENV=production` | Required for the `Secure` cookie attribute. Without it, browsers will reject the cookie on HTTPS pages. |
| `OPENAI_API_KEY` + `OPENAI_MODEL` | AI features (analyze, autofix). |
| `EMAIL_PROVIDER` | `resend` in prod, unset (= `noop`) in dev/CI. Determines which adapter handles transactional emails (signup verification). |
| `RESEND_API_KEY` | Resend send-only API key. **Required for public signup to actually deliver emails.** Without it, pending signups never get a verification link and the janitor sweeps them after 7 days. |
| `EMAIL_FROM` | Sender address. `onboarding@resend.dev` works as a default; swap to `noreply@<your-domain>` once verified in Resend. |
| `APP_BASE_URL` | Public URL of the main frontend. Used to build verification links in emails. |

### Troubleshooting "users can't log in"

1. **Browser dev tools → Application → Cookies** — is `tg_refresh` set after login? If no, the response Set-Cookie was rejected. Check:
   - `Secure` flag mismatch (HTTPS in browser, `NODE_ENV` not `production` on server, or vice versa)
   - SameSite policy (third-party context — different domain frontend ↔ backend without proper CORS)
2. **Network tab → /auth/refresh** — does the request include the `Cookie: tg_refresh=...` header? If no, the cookie's `Path=/api/auth` isn't matching the request URL. Double-check your reverse proxy isn't rewriting the path.
3. **Response missing `Access-Control-Allow-Credentials: true`** — `CORS_ORIGIN` is still `*` or the request origin isn't in the allow-list. Backend logs will say `CORS: origin not allowed`.
4. **`401` on every refresh** — the `refresh_tokens` table may have been wiped, or `JWT_SECRET` rotated. Existing sessions need to re-login.

## License

Proprietary -- TestGenie
