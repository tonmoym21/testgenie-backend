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
- All input validated with zod
- Parameterized SQL queries (no raw string interpolation)
- Rate limiting on auth (20/15min) and analysis (10/min)
- Helmet security headers
- CORS restricted to configured origin

## License

Proprietary -- TestGenie
