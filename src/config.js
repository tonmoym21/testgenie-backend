const { z } = require('zod');

// OPENAI_API_KEY is conditionally required:
//   - REQUIRED when AUTOFIX_PROVIDER is unset or 'openai' (the default).
//   - OPTIONAL when AUTOFIX_PROVIDER='ollama'.
// Honest scope note (matches the runbook follow-up): this only unblocks
// BOOT for Ollama-only users. Four other services still import this key
// and would fail at *call* time if invoked: playwrightGenerator,
// scenarioGenerator, analyzeService, and the openai provider itself.
// Disable or guard those routes in an Ollama-only deploy.
const envSchema = z.object({
  PORT: z.coerce.number().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),

  DATABASE_URL: z.string().min(1).refine(
    (s) => s.startsWith('postgresql://') || s.startsWith('postgres://'),
    { message: 'DATABASE_URL must start with postgresql:// or postgres://' }
  ),
  DB_POOL_MIN: z.coerce.number().default(2),
  DB_POOL_MAX: z.coerce.number().default(10),

  JWT_SECRET: z.string().min(32),
  JWT_ACCESS_EXPIRY: z.string().default('15m'),
  JWT_REFRESH_EXPIRY: z.string().default('7d'),

  AUTOFIX_PROVIDER: z.enum(['openai', 'ollama']).default('openai'),
  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_MODEL: z.string().default('gpt-4o'),
  OPENAI_MAX_TOKENS: z.coerce.number().default(12000),

  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(900000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().default(20),
  ANALYZE_RATE_LIMIT_WINDOW_MS: z.coerce.number().default(60000),
  ANALYZE_RATE_LIMIT_MAX: z.coerce.number().default(10),

  CORS_ORIGIN: z.string().default('http://localhost:5173'),
}).superRefine((env, ctx) => {
  if (env.AUTOFIX_PROVIDER === 'openai' && !env.OPENAI_API_KEY) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['OPENAI_API_KEY'],
      message: "Required when AUTOFIX_PROVIDER='openai' (the default). " +
               "Set AUTOFIX_PROVIDER='ollama' to make this optional.",
    });
  }
});

let config;

try {
  config = envSchema.parse(process.env);
} catch (err) {
  console.error('Invalid environment variables:');
  console.error(err.flatten().fieldErrors);
  process.exit(1);
}

module.exports = config;
