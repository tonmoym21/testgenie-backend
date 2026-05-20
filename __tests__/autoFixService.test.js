// Service-level tests for autoFixService.proposeFix.
//
// We mock both `openai` and `../src/db` so the agent loop runs without any
// external infra. The test exercises the SEQUENCE of DB writes that proves
// the atomic-claim and release-on-failure invariants — the same invariants
// the council audit added in commit 534982b. A live-DB integration suite
// (Testcontainers + the rest of the loop) is the next layer up and lives
// in its own follow-up commit.

// ---- 1. config + logger must load before src/db / src/services/* ----------
// src/config validates env vars with zod and process.exit(1)s on failure,
// so we seed just enough to get past it.
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://stub:stub@127.0.0.1/stub';
process.env.JWT_SECRET   = process.env.JWT_SECRET   || 'x'.repeat(64);
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'sk-test-stub';
process.env.NODE_ENV = 'test';

// ---- 2. Mock pg so requiring src/db doesn't open a real connection --------
jest.mock('pg', () => {
  class Pool {
    constructor() {}
    query() { return Promise.resolve({ rows: [], rowCount: 0 }); }
    on() {}
    end() { return Promise.resolve(); }
  }
  return { Pool };
});

// ---- 3. Mock OpenAI ------------------------------------------------------
// autoFixService does `new OpenAI({ apiKey })` at module load — the mock has
// to be a constructor that returns an object with `chat.completions.create`.
const mockLlmCreate = jest.fn();
jest.mock('openai', () => {
  return jest.fn().mockImplementation(() => ({
    chat: { completions: { create: mockLlmCreate } },
  }));
});

// ---- 4. Mock src/db's query so we can record + script the sequence -------
const mockDbQuery = jest.fn();
jest.mock('../src/db', () => ({
  query: (...args) => mockDbQuery(...args),
  pool: { end: () => Promise.resolve() },
}));

// ---- 5. Module under test (require AFTER mocks are in place) -------------
const autoFixService = require('../src/services/autoFixService');

// ---------------------------------------------------------------------------
// Test plumbing
// ---------------------------------------------------------------------------

/**
 * Push a sequence of canned db.query responses onto the mock. Each call to
 * db.query() pops the next one. The test asserts the actual SQL was the
 * right shape by inspecting the recorded calls afterwards.
 */
function scriptDb(responses) {
  mockDbQuery.mockReset();
  let i = 0;
  mockDbQuery.mockImplementation(() => {
    const next = responses[i++];
    if (!next) return Promise.resolve({ rows: [], rowCount: 0 });
    if (next instanceof Error) return Promise.reject(next);
    return Promise.resolve(next);
  });
}

function llmReply(newCode, explanation = 'patched it') {
  mockLlmCreate.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify({ newCode, explanation, confidence: 'high' }) } }],
  });
}

/** A canonical failure context row returned by loadFailureContext's SELECT. */
function failureRow(overrides = {}) {
  return {
    failure_id: 42,
    project_id: 1,
    failure_signature: 'abc123def4567890',
    sample_error_message: 'Element not found: #login',
    sample_error_stack: 'at /app/login.spec.ts:5:7',
    last_test_id: 7,
    file_name: 'login.spec.ts',
    spec_code: "test('login', async ({page}) => { await page.click('#login'); });\n",
    story_id: 11,
    scenario_id: 22,
    ...overrides,
  };
}

function findCall(re) {
  return mockDbQuery.mock.calls.find((c) => re.test(c[0]));
}

beforeEach(() => {
  mockLlmCreate.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('autoFixService.proposeFix', () => {
  it('happy path: claims the failure, writes attempt as proposed, stores diff + new_code', async () => {
    scriptDb([
      { rows: [failureRow()], rowCount: 1 },             // loadFailureContext SELECT
      { rows: [{ id: 42 }], rowCount: 1 },               // atomic claim UPDATE ... RETURNING id
      { rows: [{ id: 99 }], rowCount: 1 },               // insertAttempt RETURNING id
      { rows: [], rowCount: 1 },                         // prompt_excerpt UPDATE
      { rows: [], rowCount: 1 },                         // finalizeAttempt status='proposed'
    ]);
    llmReply("test('login', async ({page}) => { await page.getByRole('button', { name: /log in/i }).click(); });\n");

    const result = await autoFixService.proposeFix(42, { triggeredBy: null });

    expect(result.status).toBe('proposed');
    expect(result.fixAttemptId).toBe(99);
    expect(result.diff).toMatch(/^--- a\/login\.spec\.ts/);
    expect(result.branchName).toMatch(/^testforge\/autofix\/failure-42-/);

    // Atomic claim was issued
    const claim = findCall(/UPDATE test_failures SET fix_status = 'fix_proposed'\s+WHERE id = \$1 AND fix_status = 'open'/);
    expect(claim).toBeTruthy();
    expect(claim[1]).toEqual([42]);

    // finalizeAttempt set status='proposed' with new_code + patch_diff non-null
    const finalize = mockDbQuery.mock.calls.find(
      (c) => /UPDATE fix_attempts SET/.test(c[0]) && c[1] && c[1][1] === 'proposed'
    );
    expect(finalize).toBeTruthy();
    expect(finalize[1][2]).toBeTruthy();              // patch_diff
    expect(finalize[1][4]).toContain('getByRole');    // new_code
  });

  it('refuses to run when the claim returns 0 rows (already claimed)', async () => {
    scriptDb([
      { rows: [failureRow()], rowCount: 1 },             // loadFailureContext SELECT
      { rows: [], rowCount: 0 },                         // atomic claim — LOSES the race
    ]);

    await expect(autoFixService.proposeFix(42)).rejects.toMatchObject({
      status: 409,
      message: expect.stringMatching(/already claimed/i),
    });

    // No LLM call, no fix_attempts INSERT.
    expect(mockLlmCreate).not.toHaveBeenCalled();
    const insert = mockDbQuery.mock.calls.find((c) => /INSERT INTO fix_attempts/.test(c[0]));
    expect(insert).toBeFalsy();
  });

  it('releases the claim when the LLM throws', async () => {
    scriptDb([
      { rows: [failureRow()], rowCount: 1 },
      { rows: [{ id: 42 }], rowCount: 1 },               // claim wins
      { rows: [{ id: 99 }], rowCount: 1 },               // insertAttempt
      { rows: [], rowCount: 1 },                         // finalizeAttempt status='failed'
      { rows: [], rowCount: 1 },                         // release claim
    ]);
    mockLlmCreate.mockRejectedValueOnce(Object.assign(new Error('429 rate limited'), { status: 429 }));

    const result = await autoFixService.proposeFix(42);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/429/);

    // The release-claim UPDATE put fix_status back to 'open'.
    const release = mockDbQuery.mock.calls.find(
      (c) => /UPDATE test_failures SET fix_status = 'open'\s+WHERE id = \$1 AND fix_status = 'fix_proposed'/.test(c[0])
    );
    expect(release).toBeTruthy();
    expect(release[1]).toEqual([42]);
  });

  it('releases the claim when the LLM returns the same code (no diff)', async () => {
    const same = "test('login', async () => {});\n";
    scriptDb([
      { rows: [failureRow({ spec_code: same })], rowCount: 1 },
      { rows: [{ id: 42 }], rowCount: 1 },               // claim wins
      { rows: [{ id: 99 }], rowCount: 1 },               // insertAttempt
      { rows: [], rowCount: 1 },                         // prompt_excerpt UPDATE
      { rows: [], rowCount: 1 },                         // finalizeAttempt status='failed'
      { rows: [], rowCount: 1 },                         // release claim
    ]);
    llmReply(same);

    const result = await autoFixService.proposeFix(42);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/unchanged/i);

    const release = mockDbQuery.mock.calls.find(
      (c) => /UPDATE test_failures SET fix_status = 'open'/.test(c[0])
    );
    expect(release).toBeTruthy();
  });

  it('errors before any DB write when the failure has no linked spec code', async () => {
    scriptDb([
      { rows: [failureRow({ last_test_id: null, spec_code: null })], rowCount: 1 },
    ]);

    await expect(autoFixService.proposeFix(42)).rejects.toThrow(/no linked spec code/);

    // Critical: no claim issued, no fix_attempts row inserted, no LLM call.
    expect(mockLlmCreate).not.toHaveBeenCalled();
    const claim = mockDbQuery.mock.calls.find((c) => /UPDATE test_failures SET fix_status = 'fix_proposed'/.test(c[0]));
    expect(claim).toBeFalsy();
  });
});
