// Boot-gate tests for src/config.js. The interesting axis is the
// conditional OPENAI_API_KEY requirement based on AUTOFIX_PROVIDER —
// the rest is delegated to zod.
//
// config.js calls process.exit(1) on failure, so we can't just
// re-require it in-process. Each case spawns a child node process
// with a curated env and asserts on its exit code + stderr.

const { spawnSync } = require('child_process');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, '..', 'src', 'config.js');

function runConfig(env) {
  return spawnSync(process.execPath, ['-e', `require(${JSON.stringify(CONFIG_PATH)})`], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
  });
}

const BASE_ENV = {
  DATABASE_URL: 'postgresql://stub:stub@127.0.0.1/stub',
  JWT_SECRET: 'x'.repeat(64),
  NODE_ENV: 'test',
};

describe('config.js boot gate', () => {
  it('boots with OPENAI_API_KEY set + provider defaulting to openai', () => {
    const r = runConfig({ ...BASE_ENV, OPENAI_API_KEY: 'sk-test' });
    expect(r.status).toBe(0);
  });

  it('exits 1 when AUTOFIX_PROVIDER=openai (default) and OPENAI_API_KEY missing', () => {
    const r = runConfig({ ...BASE_ENV });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/OPENAI_API_KEY/);
    expect(r.stderr).toMatch(/AUTOFIX_PROVIDER='openai'/);
  });

  it('boots with AUTOFIX_PROVIDER=ollama and NO OPENAI_API_KEY', () => {
    const r = runConfig({ ...BASE_ENV, AUTOFIX_PROVIDER: 'ollama' });
    expect(r.status).toBe(0);
  });

  it('still boots with AUTOFIX_PROVIDER=ollama and an OPENAI_API_KEY set (additive, not forbidden)', () => {
    const r = runConfig({ ...BASE_ENV, AUTOFIX_PROVIDER: 'ollama', OPENAI_API_KEY: 'sk-test' });
    expect(r.status).toBe(0);
  });

  it('rejects an unknown AUTOFIX_PROVIDER value at boot', () => {
    const r = runConfig({ ...BASE_ENV, AUTOFIX_PROVIDER: 'claude', OPENAI_API_KEY: 'sk-test' });
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/AUTOFIX_PROVIDER/);
  });
});
