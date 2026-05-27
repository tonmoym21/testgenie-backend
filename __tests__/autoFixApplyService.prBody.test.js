// Focused tests for autoFixApplyService.buildPrBody + diffStats.
//
// The PR body is what a human reviewer sees first when an autofix lands.
// Lock the contract:
//   - explanation, when present, surfaces under a "Why this fix" heading
//   - explanation, when null (pre-migration-022 rows), no empty heading
//   - diff stats (+/- line counts) are correct from a unified diff
//   - "What was NOT changed" section is present (template-level promise)
//   - fix_attempt_id is in the body so a reviewer can correlate

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

const { buildPrBody, diffStats } = require('../src/services/autoFixApplyService');

const SAMPLE_DIFF = `--- a/tests/login.spec.ts
+++ b/tests/login.spec.ts
@@ -3,7 +3,7 @@
 test('login', async ({ page }) => {
   await page.goto('/login');
-  await page.click('#login');
+  await page.getByRole('button', { name: /log in/i }).click();
   await expect(page).toHaveURL(/\\/dashboard/);
 });
`;

function row(overrides = {}) {
  return {
    id: 99,
    test_failure_id: 42,
    failure_signature: 'abc12345',
    sample_error_message: 'TimeoutError: locator(#login) resolved to hidden element',
    model_provider: 'openai',
    model_name: 'gpt-4o',
    patch_diff: SAMPLE_DIFF,
    explanation: 'The hard-coded #login selector resolved to a hidden node. Switched to a role-based locator that targets the visible submit button.',
    ...overrides,
  };
}

describe('diffStats', () => {
  it('counts + and - lines, ignoring +++/--- headers', () => {
    const stats = diffStats(SAMPLE_DIFF);
    expect(stats.plus).toBe(1);
    expect(stats.minus).toBe(1);
    expect(stats.files).toBe(1);
  });

  it('returns zeros for empty / null input', () => {
    expect(diffStats('')).toEqual({ plus: 0, minus: 0, files: 0 });
    expect(diffStats(null)).toEqual({ plus: 0, minus: 0, files: 0 });
  });
});

describe('buildPrBody', () => {
  it('renders the LLM explanation under a "Why this fix" heading when present', () => {
    const body = buildPrBody(row(), 'tests/login.spec.ts');
    expect(body).toContain('### Why this fix');
    expect(body).toContain('hard-coded #login selector');
  });

  it('omits the "Why this fix" section entirely when explanation is null', () => {
    // Legacy rows from before migration 022 have NULL explanation. Empty
    // section headings with no body look like a templating bug to reviewers,
    // so we skip the section entirely rather than printing "### Why this fix\n".
    const body = buildPrBody(row({ explanation: null }), 'tests/login.spec.ts');
    expect(body).not.toContain('### Why this fix');
  });

  it('embeds diff stats from the patch_diff', () => {
    const body = buildPrBody(row(), 'tests/login.spec.ts');
    // The body wraps each number in backticks for markdown formatting
    // (`1` file changed, `+1` / `-1` lines). Regex tolerates the backticks
    // so this test won't break if we tweak the punctuation later.
    expect(body).toMatch(/`?1`? file changed[\s\S]*`?\+1`?[\s\S]*`?-1`?/);
  });

  it('always includes the "What was NOT changed" section so reviewers see the scope guarantee', () => {
    const body = buildPrBody(row(), 'tests/login.spec.ts');
    expect(body).toContain('### What was NOT changed');
    expect(body).toContain('tests/login.spec.ts');
    expect(body).toMatch(/root cause/i);
  });

  it('keeps fix_attempt_id in the trailer for human correlation back to the DB', () => {
    const body = buildPrBody(row(), 'tests/login.spec.ts');
    expect(body).toContain('_fix_attempt_id: 99_');
  });

  it('caps explanation at 2000 chars so a runaway LLM essay does not break the PR API', () => {
    // GitHub allows ~65k chars in a PR body but a 50kb explanation is a
    // sign of LLM misbehavior, not legitimate signal. Soft cap so the
    // rest of the template still renders.
    const huge = 'x'.repeat(5000);
    const body = buildPrBody(row({ explanation: huge }), 'tests/login.spec.ts');
    const explanationSection = body.split('### Why this fix')[1].split('### Failure sample')[0];
    expect(explanationSection.replace(/\s/g, '').length).toBeLessThanOrEqual(2000);
  });
});
