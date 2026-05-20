// Unit tests for repoConfigService.
// Pure mocked-db tests — no real Postgres. Asserts SQL shape + result handling.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub:stub@127.0.0.1/stub';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

jest.mock('pg', () => {
  class Pool {
    constructor() {}
    query() { return Promise.resolve({ rows: [], rowCount: 0 }); }
    on() {}
    end() { return Promise.resolve(); }
  }
  return { Pool };
});

const repoConfig = require('../src/services/repoConfigService');

function makeDb(byPattern = []) {
  const calls = [];
  const fn = (sql, params) => {
    calls.push({ sql, params });
    for (const [re, response] of byPattern) if (re.test(sql)) return Promise.resolve(response);
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  return { query: fn, calls };
}

const sampleRow = {
  id: 7, project_id: 42, repo_path: '/tmp/r', base_branch: 'main',
  remote_name: 'origin', github_repo: 'acme/widgets', spec_dir: 'tests',
  organization_id: 1, created_at: new Date(), updated_at: new Date(),
};

describe('repoConfigService.getByProjectId', () => {
  it('SELECTs by project_id and returns the row', async () => {
    const db = makeDb([[/FROM project_repo_configs.*WHERE project_id/s, { rows: [sampleRow], rowCount: 1 }]]);
    const out = await repoConfig.getByProjectId(42, { db });
    expect(out).toEqual(sampleRow);
    expect(db.calls[0].params).toEqual([42]);
  });

  it('returns null when no row exists', async () => {
    const db = makeDb();
    expect(await repoConfig.getByProjectId(999, { db })).toBeNull();
  });
});

describe('repoConfigService.getByFixAttemptId', () => {
  it('JOINs fix_attempts -> test_failures -> project_repo_configs', async () => {
    const db = makeDb([[/FROM fix_attempts.*JOIN test_failures.*JOIN project_repo_configs/s,
      { rows: [sampleRow], rowCount: 1 }]]);
    const out = await repoConfig.getByFixAttemptId(99, { db });
    expect(out).toEqual(sampleRow);
    expect(db.calls[0].params).toEqual([99]);
  });

  it('returns null when the chain has no config row', async () => {
    const db = makeDb();
    expect(await repoConfig.getByFixAttemptId(99, { db })).toBeNull();
  });
});

describe('repoConfigService.getByGithubRepo', () => {
  it('looks up by github_repo string', async () => {
    const db = makeDb([[/FROM project_repo_configs.*WHERE github_repo/s, { rows: [sampleRow], rowCount: 1 }]]);
    const out = await repoConfig.getByGithubRepo('acme/widgets', { db });
    expect(out.github_repo).toBe('acme/widgets');
    expect(db.calls[0].params).toEqual(['acme/widgets']);
  });
});

describe('repoConfigService.upsert', () => {
  it('requires projectId and repoPath', async () => {
    const db = makeDb();
    await expect(repoConfig.upsert({}, { db })).rejects.toThrow(/projectId is required/);
    await expect(repoConfig.upsert({ projectId: 1 }, { db })).rejects.toThrow(/repoPath is required/);
  });

  it('issues INSERT ... ON CONFLICT (project_id) DO UPDATE', async () => {
    const db = makeDb([[/INSERT INTO project_repo_configs.*ON CONFLICT \(project_id\) DO UPDATE/s,
      { rows: [sampleRow], rowCount: 1 }]]);
    const out = await repoConfig.upsert({
      projectId: 42, repoPath: '/tmp/r', githubRepo: 'acme/widgets',
    }, { db });
    expect(out).toEqual(sampleRow);
    const call = db.calls[0];
    expect(call.params[0]).toBe(42);
    expect(call.params[1]).toBe('/tmp/r');
    // baseBranch, remoteName not set → null params, COALESCE in SQL applies defaults
    expect(call.params[2]).toBeNull();
    expect(call.params[3]).toBeNull();
    expect(call.params[4]).toBe('acme/widgets');
  });
});

// ---------------------------------------------------------------------------
// Fallback wiring — verify applyService + verifyService honor the table when
// the caller omits the override. Pure unit-level, no real DB.
// ---------------------------------------------------------------------------

describe('applyFix uses repoConfig fallback when opts.repo is missing', () => {
  const { applyFix } = require('../src/services/autoFixApplyService');

  it('resolves repo + base + remote from the config row', async () => {
    const cfg = { repo_path: '/tmp/customer-repo', base_branch: 'develop', remote_name: 'upstream' };
    const repoConfigStub = {
      getByFixAttemptId: jest.fn().mockResolvedValue(cfg),
    };

    const calls = [];
    const fakeFs = {
      existsSync: (p) => /\.git$/.test(p) || /spec\.ts$/.test(p),
      readdirSync: () => [{ name: 'login.spec.ts', isDirectory: () => false }],
      writeFileSync: () => {},
      unlinkSync: () => {},
    };
    const runGit = (cwd, args) => {
      calls.push({ cwd, args });
      // checkout / commit / push / status no-ops; rev-parse returns toplevel
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return cwd;
      if (args[0] === 'status') return '';
      if (args[0] === 'rev-parse' && args[1] === '--verify') throw new Error('not exists');
      return '';
    };

    const db = {
      query: jest.fn().mockImplementation((sql) => {
        if (/SELECT fa\.\*/.test(sql)) {
          return Promise.resolve({
            rows: [{
              id: 99, test_failure_id: 42, status: 'proposed',
              branch_name: 'testforge/autofix/failure-42-abc',
              new_code: 'fixed code', test_file_name: 'login.spec.ts',
              model_provider: 'openai', model_name: 'gpt-4o',
              failure_signature: 'sig', sample_error_message: 'err',
            }],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      }),
    };

    await applyFix(
      { fixAttemptId: 99 },  // no repo, no base, no remote
      {
        db, fs: fakeFs, runGit,
        runGh: () => '',
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        repoConfig: repoConfigStub,
      },
    );

    expect(repoConfigStub.getByFixAttemptId).toHaveBeenCalledWith(99, expect.any(Object));
    // The new branch was created off `develop` (from config), not the HEAD default.
    // Verify by checking that we never asked `rev-parse --abbrev-ref HEAD`.
    const askedHead = calls.some((c) => c.args[0] === 'rev-parse' && c.args[1] === '--abbrev-ref');
    expect(askedHead).toBe(false);
  });

  it('throws a clear error when neither opts nor config supplies repo', async () => {
    const repoConfigStub = { getByFixAttemptId: jest.fn().mockResolvedValue(null) };
    await expect(applyFix(
      { fixAttemptId: 99 },
      {
        db: { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
        fs: {}, runGit: () => '', runGh: () => '',
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        repoConfig: repoConfigStub,
      },
    )).rejects.toThrow(/No repo path supplied and no project_repo_configs row/);
  });

  it('does not consult the config when opts.repo + base + remote are all set', async () => {
    const repoConfigStub = { getByFixAttemptId: jest.fn() };
    try {
      await applyFix(
        { fixAttemptId: 99, repo: '/tmp/x', base: 'main', remote: 'origin' },
        {
          // Minimal deps — applyFix will fail soon after due to missing .git,
          // but we only care that the config lookup didn't run.
          db: { query: () => Promise.resolve({ rows: [], rowCount: 0 }) },
          fs: { existsSync: () => false },
          runGit: () => '', runGh: () => '',
          logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
          repoConfig: repoConfigStub,
        },
      );
    } catch { /* expected — we're not setting up a full happy path */ }
    expect(repoConfigStub.getByFixAttemptId).not.toHaveBeenCalled();
  });
});

describe('verifyFix uses repoConfig fallback', () => {
  const { verifyFix } = require('../src/services/autoFixVerifyService');

  it('resolves repo + specDir from config when opts is bare', async () => {
    const cfg = { repo_path: '/tmp/cust', base_branch: 'main', remote_name: 'origin', spec_dir: 'e2e/specs' };
    const repoConfigStub = { getByFixAttemptId: jest.fn().mockResolvedValue(cfg) };

    const db = {
      query: jest.fn().mockImplementation((sql) => {
        if (/FROM fix_attempts fa/.test(sql)) {
          return Promise.resolve({
            rows: [{
              id: 99, failure_id: 42, status: 'proposed',
              branch_name: 'b', test_file_name: 'login.spec.ts',
            }],
            rowCount: 1,
          });
        }
        return Promise.resolve({ rows: [], rowCount: 1 });
      }),
    };

    const playwrightCalls = [];
    const runPlaywright = (cwd, args) => {
      playwrightCalls.push({ cwd, args });
      return { exitCode: 0, stdout: 'passed', stderr: '' };
    };

    await verifyFix(
      { fixAttemptId: 99 },
      {
        db, runPlaywright,
        runGit: () => 'main',
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
        repoConfig: repoConfigStub,
      },
    );

    expect(repoConfigStub.getByFixAttemptId).toHaveBeenCalledWith(99, expect.any(Object));
    // The spec arg passed to Playwright should use the configured spec_dir, not the 'tests' default.
    const specArg = playwrightCalls[0].args.find((a) => a.endsWith('login.spec.ts'));
    expect(specArg).toMatch(/e2e[\\/]specs[\\/]login\.spec\.ts/);
  });
});
