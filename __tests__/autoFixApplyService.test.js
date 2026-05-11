// Service-level tests for autoFixApplyService.applyFix.
//
// The whole point of extracting this orchestrator out of the CLI script
// was to make the rollback path testable. Council audit defects #1 and #2
// both lived here — and a CLI-shaped script that shells real `git` and
// real `gh` left them outside any regression net. This suite locks them.

process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub:stub@127.0.0.1/stub';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

// src/db is loaded transitively (the service requires it), so stub `pg`
// to keep the import cheap. The test never actually calls through —
// we inject a fake db into applyFix.
jest.mock('pg', () => {
  class Pool {
    constructor() {}
    query() { return Promise.resolve({ rows: [], rowCount: 0 }); }
    on() {}
    end() { return Promise.resolve(); }
  }
  return { Pool };
});

const path = require('path');
const { applyFix } = require('../src/services/autoFixApplyService');

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * Fake fs supporting only what the service uses: existsSync, readdirSync,
 * writeFileSync, unlinkSync. Backed by a flat in-memory map of
 * absolute-path -> { kind: 'file'|'dir', content?: string }.
 */
function makeFs(initial = {}) {
  const files = new Map();
  for (const [p, v] of Object.entries(initial)) files.set(p, v);

  const fs = {
    existsSync: (p) => files.has(p),
    readdirSync: (dir, opts) => {
      // Return only the immediate children.
      const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
      const seen = new Set();
      for (const p of files.keys()) {
        if (!p.startsWith(prefix)) continue;
        const rest = p.slice(prefix.length);
        const head = rest.split(path.sep)[0];
        if (head) seen.add(head);
      }
      return [...seen].map((name) => {
        const full = prefix + name;
        const entry = files.get(full) || files.get(full + path.sep) || { kind: 'dir' };
        return {
          name,
          isDirectory: () => entry.kind === 'dir' || hasChildren(full),
          isFile: () => entry.kind === 'file',
        };
      });
    },
    writeFileSync: (p, content) => { files.set(p, { kind: 'file', content }); fs.writes.push({ p, content }); },
    unlinkSync: (p) => { files.delete(p); },
    writes: [],
    _files: files,
  };
  function hasChildren(p) {
    const prefix = p + path.sep;
    for (const k of files.keys()) if (k.startsWith(prefix)) return true;
    return false;
  }
  return fs;
}

/**
 * Fake runGit that returns scripted responses keyed by the first one or two
 * args. Records every call. Throw an Error to simulate a git failure.
 */
function makeRunGit(scripts = {}) {
  const calls = [];
  const fn = (cwd, args) => {
    calls.push({ cwd, args });
    const key = args.slice(0, 2).join(' ');
    const single = args[0];
    const matched = scripts[args.join(' ')] ?? scripts[key] ?? scripts[single];
    if (matched === undefined) return '';
    if (matched instanceof Error) throw matched;
    if (typeof matched === 'function') return matched(args);
    return matched;
  };
  fn.calls = calls;
  return fn;
}

/** Fake runGh returning a canned PR URL string, or throwing. */
function makeRunGh(response) {
  const calls = [];
  const fn = (cwd, args) => {
    calls.push({ cwd, args });
    if (response instanceof Error) throw response;
    return response;
  };
  fn.calls = calls;
  return fn;
}

/** Fake db whose query() consults a [regex, response] table. */
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

/** Canonical proposed fix_attempts row returned by loadFixAttempt's SELECT. */
function fixRow(overrides = {}) {
  return {
    id: 99,
    test_failure_id: 42,
    status: 'proposed',
    new_code: "test('login', async () => { /* patched */ });\n",
    branch_name: 'testforge/autofix/failure-42-abc12345',
    model_provider: 'openai',
    model_name: 'gpt-4o',
    failure_signature: 'abc123def4567890',
    sample_error_message: 'Element not found: #login',
    test_file_name: 'login.spec.ts',
    ...overrides,
  };
}

/** A minimal in-memory repo that contains a .git dir and one target spec. */
function repoWithSpec(repo, specRel = 'tests/login.spec.ts', specBody = 'old') {
  return {
    [path.join(repo, '.git')]: { kind: 'dir' },
    [path.join(repo, 'tests')]: { kind: 'dir' },
    [path.join(repo, specRel)]: { kind: 'file', content: specBody },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autoFixApplyService.applyFix', () => {
  const REPO = path.resolve('/tmp/fake-repo');
  const TARGET = path.join(REPO, 'tests/login.spec.ts');

  it('happy path (no PR): writes file, commits, returns proposed with applied_at', async () => {
    const fs = makeFs(repoWithSpec(REPO));
    const runGit = makeRunGit({
      'rev-parse': '',                                       // multiple uses default ''
      'rev-parse --show-toplevel': REPO,
      'rev-parse --abbrev-ref': 'main',
      'rev-parse --verify': new Error('not a ref'),          // branch does NOT exist locally
      'status': '',                                          // clean working tree
    });
    const runGh = makeRunGh('');                              // never called
    const db = makeDb([
      [/FROM fix_attempts/, { rows: [fixRow()], rowCount: 1 }],
      [/UPDATE fix_attempts SET/, { rows: [], rowCount: 1 }],
    ]);

    const out = await applyFix(
      { fixAttemptId: 99, repo: REPO },
      { db, fs, logger: silentLogger, runGit, runGh },
    );

    expect(out.status).toBe('proposed');
    expect(out.branchName).toBe('testforge/autofix/failure-42-abc12345');
    expect(out.prUrl).toBeNull();

    // Spec file was overwritten with new_code
    const written = fs.writes.find((w) => w.p === TARGET);
    expect(written).toBeTruthy();
    expect(written.content).toContain('patched');

    // No push, no gh call
    expect(runGit.calls.some((c) => c.args[0] === 'push')).toBe(false);
    expect(runGh.calls).toHaveLength(0);

    // recordApply UPDATE issued with status='proposed'
    const update = db.calls.find((c) => /UPDATE fix_attempts SET/.test(c.sql));
    expect(update.params[1]).toBe('proposed');
  });

  it('happy path (--open-pr): pushes, opens PR, status pr_opened with pr_url and pr_number', async () => {
    const fs = makeFs(repoWithSpec(REPO));
    const runGit = makeRunGit({
      'rev-parse --show-toplevel': REPO,
      'rev-parse --abbrev-ref': 'main',
      'rev-parse --verify': new Error('not a ref'),
      'status': '',
    });
    const runGh = makeRunGh('https://github.com/acme/test/pull/847');
    const db = makeDb([
      [/FROM fix_attempts/, { rows: [fixRow()], rowCount: 1 }],
      [/UPDATE fix_attempts SET/, { rows: [], rowCount: 1 }],
    ]);

    const out = await applyFix(
      { fixAttemptId: 99, repo: REPO, openPr: true },
      { db, fs, logger: silentLogger, runGit, runGh },
    );

    expect(out.status).toBe('pr_opened');
    expect(out.prUrl).toBe('https://github.com/acme/test/pull/847');
    expect(out.prNumber).toBe(847);

    // Push happened
    expect(runGit.calls.some((c) => c.args[0] === 'push' && c.args.includes('-u'))).toBe(true);
    // gh was called with the right title shape
    expect(runGh.calls).toHaveLength(1);
    const ghArgs = runGh.calls[0].args;
    expect(ghArgs).toContain('pr');
    expect(ghArgs).toContain('create');
    expect(ghArgs[ghArgs.indexOf('--head') + 1]).toBe('testforge/autofix/failure-42-abc12345');
    expect(ghArgs[ghArgs.indexOf('--title') + 1]).toMatch(/login\.spec\.ts/);
  });

  it('ROLLBACK after push success but gh fails — deletes the remote branch', async () => {
    // This is council audit defect #1: previous rollback only ran `branch -D`
    // locally, leaving an orphaned remote ref that collided with the next
    // proposal's deterministic branch_name.
    const fs = makeFs(repoWithSpec(REPO));
    const runGit = makeRunGit({
      'rev-parse --show-toplevel': REPO,
      'rev-parse --abbrev-ref': 'main',
      'rev-parse --verify': new Error('not a ref'),
      'status': '',
    });
    const runGh = makeRunGh(new Error('gh: rate limited'));   // gh fails
    const db = makeDb([
      [/FROM fix_attempts/, { rows: [fixRow()], rowCount: 1 }],
      [/UPDATE fix_attempts SET/, { rows: [], rowCount: 1 }],
    ]);

    await expect(applyFix(
      { fixAttemptId: 99, repo: REPO, openPr: true },
      { db, fs, logger: silentLogger, runGit, runGh },
    )).rejects.toThrow(/gh: rate limited/);

    // The new rollback ran `push origin --delete <branch>` to remove the
    // orphan. That's the specific argv we lock here.
    const remoteDelete = runGit.calls.find(
      (c) => c.args[0] === 'push' && c.args.includes('--delete')
    );
    expect(remoteDelete).toBeTruthy();
    expect(remoteDelete.args).toEqual(['push', 'origin', '--delete', 'testforge/autofix/failure-42-abc12345']);

    // And we DID update fix_attempts to failed.
    const update = db.calls.find((c) => /UPDATE fix_attempts SET/.test(c.sql));
    expect(update.params[1]).toBe('failed');
  });

  it('ROLLBACK after writeFileSync but commit fails — discards working-tree write before checkout base', async () => {
    // Council audit defect #2: if the commit step blew up (pre-commit hook,
    // missing user.email, signing), the old rollback ran `checkout base`
    // which would silently fail ("would be overwritten") because the spec
    // was still rewritten on disk. The next run then tripped assertCleanFor.
    const fs = makeFs(repoWithSpec(REPO));
    const runGit = makeRunGit({
      'rev-parse --show-toplevel': REPO,
      'rev-parse --abbrev-ref': 'main',
      'rev-parse --verify': new Error('not a ref'),
      'status': '',
      'commit': new Error('pre-commit hook failed'),         // boom
    });
    const runGh = makeRunGh('');
    const db = makeDb([
      [/FROM fix_attempts/, { rows: [fixRow()], rowCount: 1 }],
      [/UPDATE fix_attempts SET/, { rows: [], rowCount: 1 }],
    ]);

    await expect(applyFix(
      { fixAttemptId: 99, repo: REPO },
      { db, fs, logger: silentLogger, runGit, runGh },
    )).rejects.toThrow(/pre-commit/);

    // Rollback issued `checkout -- tests/login.spec.ts` to discard the write
    // BEFORE running `checkout main`. We assert both ran AND the order.
    const idxDiscard = runGit.calls.findIndex(
      (c) => c.args[0] === 'checkout' && c.args[1] === '--' && c.args[2] === 'tests/login.spec.ts'
    );
    const idxBaseCheckout = runGit.calls.findIndex(
      (c) => c.args[0] === 'checkout' && c.args.includes('--quiet')
    );
    expect(idxDiscard).toBeGreaterThanOrEqual(0);
    expect(idxBaseCheckout).toBeGreaterThan(idxDiscard);

    // Push --delete was NOT called: we never pushed.
    expect(runGit.calls.some((c) => c.args.includes('--delete'))).toBe(false);
  });

  it('refuses to overwrite an existing branch', async () => {
    const fs = makeFs(repoWithSpec(REPO));
    const runGit = makeRunGit({
      'rev-parse --show-toplevel': REPO,
      'rev-parse --abbrev-ref': 'main',
      'rev-parse --verify': 'abc123',                        // branch DOES exist
      'status': '',
    });
    const runGh = makeRunGh('');
    const db = makeDb([
      [/FROM fix_attempts/, { rows: [fixRow()], rowCount: 1 }],
    ]);

    await expect(applyFix(
      { fixAttemptId: 99, repo: REPO },
      { db, fs, logger: silentLogger, runGit, runGh },
    )).rejects.toThrow(/already exists/);

    // No checkout -b, no writes, no recordApply UPDATE.
    expect(runGit.calls.some((c) => c.args[0] === 'checkout' && c.args[1] === '-b')).toBe(false);
    expect(fs.writes).toHaveLength(0);
    expect(db.calls.some((c) => /UPDATE fix_attempts/.test(c.sql))).toBe(false);
  });

  it('refuses when the row is not in a proposable status', async () => {
    const fs = makeFs(repoWithSpec(REPO));
    const runGit = makeRunGit({ 'rev-parse --show-toplevel': REPO });
    const db = makeDb([
      [/FROM fix_attempts/, { rows: [fixRow({ status: 'pr_opened' })], rowCount: 1 }],
    ]);

    await expect(applyFix(
      { fixAttemptId: 99, repo: REPO },
      { db, fs, logger: silentLogger, runGit, runGh: makeRunGh('') },
    )).rejects.toThrow(/expected "proposed"/);
  });

  it('refuses when new_code is missing', async () => {
    const fs = makeFs(repoWithSpec(REPO));
    const runGit = makeRunGit({ 'rev-parse --show-toplevel': REPO });
    const db = makeDb([
      [/FROM fix_attempts/, { rows: [fixRow({ new_code: null })], rowCount: 1 }],
    ]);

    await expect(applyFix(
      { fixAttemptId: 99, repo: REPO },
      { db, fs, logger: silentLogger, runGit, runGh: makeRunGh('') },
    )).rejects.toThrow(/no new_code/);
  });
});
