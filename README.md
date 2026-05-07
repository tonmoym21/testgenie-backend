# TestGenie Backend MVP

AI-powered QA automation platform -- Phase 0 prototype.

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
| POST | `/api/auth/register` | No | Create account |
| POST | `/api/auth/login` | No | Get tokens |
| POST | `/api/auth/refresh` | No | Rotate tokens |
| POST | `/api/auth/logout` | Yes | Revoke refresh token |

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
| `CORS_ORIGIN` | **Must** be a concrete allow-list, never `*`. The cookie requires credentialed CORS, which forbids wildcard origins. Use a comma-separated list, e.g. `https://app.example.com,https://*.vercel.app`. |
| `NODE_ENV=production` | Required for the `Secure` cookie attribute. Without it, browsers will reject the cookie on HTTPS pages. |
| `JWT_SECRET` | 32+ chars; rotating this invalidates every active session. |

### Troubleshooting "users can't log in"

1. **Browser dev tools → Application → Cookies** — is `tg_refresh` set after login? If no, the response Set-Cookie was rejected. Check:
   - `Secure` flag mismatch (HTTPS in browser, `NODE_ENV` not `production` on server, or vice versa)
   - SameSite policy (third-party context — different domain frontend ↔ backend without proper CORS)
2. **Network tab → /auth/refresh** — does the request include the `Cookie: tg_refresh=...` header? If no, the cookie's `Path=/api/auth` isn't matching the request URL. Double-check your reverse proxy isn't rewriting the path.
3. **Response missing `Access-Control-Allow-Credentials: true`** — `CORS_ORIGIN` is still `*` or the request origin isn't in the allow-list. Backend logs will say `CORS: origin not allowed`.
4. **`401` on every refresh** — the `refresh_tokens` table may have been wiped, or `JWT_SECRET` rotated. Existing sessions need to re-login.

## License

Proprietary -- TestGenie
