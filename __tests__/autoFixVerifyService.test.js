// Service-level tests for autoFixVerifyService.verifyFix.
// Mock db + git + Playwright; cover the verified / verify_failed / release-claim paths.

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

const { verifyFix, markMerged } = require('../src/services/autoFixVerifyService');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function makeRunGit(scripts = {}) {
  const calls = [];
  const fn = (cwd, args) => {
    calls.push({ cwd, args });
    const key = args.slice(0, 2).join(' ');
    const single = args[0];
    const matched = scripts[args.join(' ')] ?? scripts[key] ?? scripts[single];
    if (matched === undefined) return '';
    if (matched instanceof Error) throw matched;
    return matched;
  };
  fn.calls = calls;
  return fn;
}

function makePlaywright(result) {
  const calls = [];
  const fn = (cwd, args) => {
    calls.push({ cwd, args });
    return typeof result === 'function' ? result(args) : result;
  };
  fn.calls = calls;
  return fn;
}

function makeDb(byPattern) {
  const calls = [];
  const fn = (sql, params) => {
    calls.push({ sql, params });
    for (const [re, response] of byPattern) if (re.test(sql)) return Promise.resolve(response);
    return Promise.resolve({ rows: [], rowCount: 0 });
  };
  return { query: fn, calls };
}

const silentLogger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function fixRow(overrides = {}) {
  return {
    id: 99,
    test_failure_id: 42,
    failure_id: 42,
    status: 'proposed',
    branch_name: 'testforge/autofix/failure-42-abc12345',
    test_file_name: 'login.spec.ts',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autoFixVerifyService.verifyFix', () => {
  it('verified: Playwright exits 0 -> records verified, leaves test_failures alone', async () => {
    const runGit = makeRunGit({ 'rev-parse': 'main' });
    const runPlaywright = makePlaywright({ exitCode: 0, stdout: '1 passed', stderr: '' });
    const db = makeDb([
      [/FROM fix_attempts/, { rows: [fixRow()], rowCount: 1 }],
      [/UPDATE fix_attempts SET status = 'verified'/, { rows: [], rowCount: 1 }],
    ]);

    const out = await verifyFix(
      { fixAttemptId: 99, repo: '/tmp/r', base: 'main' },
      { db, logger: silentLogger, runGit, runPlaywright },
    );
    expect(out.status).toBe('verified');
    expect(out.exitCode).toBe(0);

    // Real call sequence: checkout agent branch, run playwright, checkout base.
    const order = runGit.calls.map((c) => c.args.join(' '));
    expect(order).toContain('checkout testforge/autofix/failure-42-abc12345');
    expect(order).toContain('checkout main');
    expect(runPlaywright.calls).toHaveLength(1);
    expect(runPlaywright.calls[0].args).toContain('playwright');
    expect(runPlaywright.calls[0].args).toContain('test');

    // The "set 'fix_status' back to 'open'" UPDATE must NOT have run.
    expect(db.calls.some((c) => /UPDATE test_failures SET fix_status = 'open'/.test(c.sql))).toBe(false);
  });

  it('verify_failed: non-zero exit -> records verify_failed AND releases the claim', async () => {
    const runGit = makeRunGit({ 'rev-parse': 'main' });
    const runPlaywright = makePlaywright({
      exitCode: 1, stdout: '1 failed', stderr: 'TimeoutError: locator(\'#login\')',
    });
    const db = makeDb([
      [/FROM fix_attempts/, { rows: [fixRow()], rowCount: 1 }],
      [/UPDATE fix_attempts SET status = 'verify_failed'/, { rows: [], rowCount: 1 }],
      [/UPDATE test_failures SET fix_status = 'open'/, { rows: [], rowCount: 1 }],
    ]);

    const out = await verifyFix(
      { fixAttemptId: 99, repo: '/tmp/r', base: 'main' },
      { db, logger: silentLogger, runGit, runPlaywright },
    );
    expect(out.status).toBe('verify_failed');
    expect(out.exitCode).toBe(1);
    expect(out.stderrTail).toMatch(/TimeoutError/);

    // The release-claim UPDATE happened.
    const release = db.calls.find(
      (c) => /UPDATE test_failures SET fix_status = 'open'/.test(c.sql)
    );
    expect(release).toBeTruthy();
    expect(release.params).toEqual([42]);  // failure_id
  });

  it('returns to base branch even when Playwright itself throws', async () => {
    // runPlaywright is contractually no-throw, but defense in depth.
    const runGit = makeRunGit({ 'rev-parse': 'main' });
    const runPlaywright = makePlaywright(() => { throw new Error('npx not found'); });
    const db = makeDb([
      [/FROM fix_attempts/, { rows: [fixRow()], rowCount: 1 }],
    ]);

    await expect(verifyFix(
      { fixAttemptId: 99, repo: '/tmp/r', base: 'main' },
      { db, logger: silentLogger, runGit, runPlaywright },
    )).rejects.toThrow(/npx not found/);

    // We still checked out base in the finally.
    const lastCheckout = [...runGit.calls].reverse().find((c) => c.args[0] === 'checkout');
    expect(lastCheckout.args[1]).toBe('main');
  });

  // Regression: on Windows path.join emits `tests\login.spec.ts`, and
  // runPlaywright spawns with shell:true — the shell eats the backslash
  // and Playwright sees `testslogin.spec.ts`, which matches nothing, so
  // verify dies with "No tests found." The fix normalizes to POSIX
  // separators at the boundary. This test asserts the spawn arg never
  // contains a backslash, host OS irrespective.
  it('passes a POSIX-separator spec path to Playwright (no backslashes)', async () => {
    const runGit = makeRunGit({ 'rev-parse': 'main' });
    const runPlaywright = makePlaywright({ exitCode: 0, stdout: '1 passed', stderr: '' });
    const db = makeDb([
      [/FROM fix_attempts/, { rows: [fixRow()], rowCount: 1 }],
      [/UPDATE fix_attempts SET status = 'verified'/, { rows: [], rowCount: 1 }],
    ]);

    await verifyFix(
      { fixAttemptId: 99, repo: '/tmp/r', base: 'main' },
      { db, logger: silentLogger, runGit, runPlaywright },
    );

    expect(runPlaywright.calls).toHaveLength(1);
    const args = runPlaywright.calls[0].args;
    // No arg may contain a backslash — that would be the bug returning.
    for (const a of args) expect(a).not.toMatch(/\\/);
    // And the spec arg specifically uses forward slashes.
    expect(args).toContain('tests/login.spec.ts');
  });

  // Regression companion: caller-supplied opts.specPath that already has
  // backslashes (e.g. a Windows-side admin pasting a path from File
  // Explorer) must also get normalized — not just the path.join branch.
  it('normalizes backslashes in caller-supplied opts.specPath', async () => {
    const runGit = makeRunGit({ 'rev-parse': 'main' });
    const runPlaywright = makePlaywright({ exitCode: 0, stdout: '1 passed', stderr: '' });
    const db = makeDb([
      [/FROM fix_attempts/, { rows: [fixRow()], rowCount: 1 }],
      [/UPDATE fix_attempts SET status = 'verified'/, { rows: [], rowCount: 1 }],
    ]);

    await verifyFix(
      { fixAttemptId: 99, repo: '/tmp/r', base: 'main', specPath: 'tests\\nested\\login.spec.ts' },
      { db, logger: silentLogger, runGit, runPlaywright },
    );

    const args = runPlaywright.calls[0].args;
    for (const a of args) expect(a).not.toMatch(/\\/);
    expect(args).toContain('tests/nested/login.spec.ts');
  });

  it('refuses to verify a fix_attempts row not in proposed/pr_opened', async () => {
    const runGit = makeRunGit();
    const runPlaywright = makePlaywright({ exitCode: 0 });
    const db = makeDb([
      [/FROM fix_attempts/, { rows: [fixRow({ status: 'failed' })], rowCount: 1 }],
    ]);

    await expect(verifyFix(
      { fixAttemptId: 99, repo: '/tmp/r' },
      { db, logger: silentLogger, runGit, runPlaywright },
    )).rejects.toThrow(/verify needs/);
    expect(runPlaywright.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// markMerged
// ---------------------------------------------------------------------------

describe('autoFixVerifyService.markMerged', () => {
  it('verified -> merged: flips fix_attempts.status and test_failures.fix_status', async () => {
    const db = makeDb([
      [/SELECT fa\.id, fa\.test_failure_id, fa\.status, tf\.project_id/, {
        rows: [{ id: 99, test_failure_id: 42, status: 'verified', project_id: 7 }], rowCount: 1,
      }],
      [/UPDATE fix_attempts SET status = 'merged'/, { rows: [], rowCount: 1 }],
      [/UPDATE test_failures SET fix_status = 'resolved'/, { rows: [], rowCount: 1 }],
    ]);
    const out = await markMerged({ fixAttemptId: 99 }, { db, logger: silentLogger });
    expect(out).toEqual({ fixAttemptId: 99, status: 'merged', failureId: 42 });

    // Both UPDATEs fired with the right params.
    const faUpdate = db.calls.find((c) => /UPDATE fix_attempts SET status = 'merged'/.test(c.sql));
    expect(faUpdate.params).toEqual([99]);
    const tfUpdate = db.calls.find((c) => /UPDATE test_failures SET fix_status = 'resolved'/.test(c.sql));
    expect(tfUpdate.params).toEqual([42]);
  });

  it('pr_opened -> merged: also legal (skip-verify path)', async () => {
    const db = makeDb([
      [/SELECT fa\.id, fa\.test_failure_id, fa\.status, tf\.project_id/, {
        rows: [{ id: 99, test_failure_id: 42, status: 'pr_opened', project_id: 7 }], rowCount: 1,
      }],
      [/UPDATE fix_attempts/, { rows: [], rowCount: 1 }],
      [/UPDATE test_failures/, { rows: [], rowCount: 1 }],
    ]);
    const out = await markMerged({ fixAttemptId: 99 }, { db, logger: silentLogger });
    expect(out.status).toBe('merged');
  });

  it('refuses to merge from a non-mergeable state', async () => {
    const db = makeDb([
      [/SELECT fa\.id, fa\.test_failure_id, fa\.status, tf\.project_id/, {
        rows: [{ id: 99, test_failure_id: 42, status: 'verify_failed', project_id: 7 }], rowCount: 1,
      }],
    ]);
    await expect(markMerged({ fixAttemptId: 99 }, { db, logger: silentLogger }))
      .rejects.toThrow(/markMerged needs/);

    // No UPDATEs.
    expect(db.calls.some((c) => /UPDATE/.test(c.sql))).toBe(false);
  });

  it('throws on missing row', async () => {
    const db = makeDb([
      [/SELECT fa\.id, fa\.test_failure_id, fa\.status, tf\.project_id/, { rows: [], rowCount: 0 }],
    ]);
    await expect(markMerged({ fixAttemptId: 999 }, { db, logger: silentLogger }))
      .rejects.toThrow(/not found/);
  });
});
