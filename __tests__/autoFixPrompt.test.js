// Pure-function tests for the auto-fix prompt builder.

const { buildFixPrompt, FIX_SYSTEM_PROMPT } = require('../src/services/autoFixPrompt');

describe('buildFixPrompt', () => {
  it('includes file name, error message, stack, and spec source', () => {
    const p = buildFixPrompt({
      fileName: 'login.spec.ts',
      specCode: 'test("login", async () => {});',
      errorMessage: 'Element not found: #login',
      errorStack: 'at /app/login.spec.ts:5:7',
    });
    expect(p).toMatch(/File: login\.spec\.ts/);
    expect(p).toMatch(/Element not found: #login/);
    expect(p).toMatch(/at \/app\/login\.spec\.ts:5:7/);
    expect(p).toMatch(/test\("login"/);
  });

  it('truncates long stacks rather than blowing the context window', () => {
    const longStack = 'at line\n'.repeat(2000);  // ~16kb
    const p = buildFixPrompt({
      fileName: 't.ts',
      specCode: 'x',
      errorMessage: 'boom',
      errorStack: longStack,
    });
    expect(p.length).toBeLessThan(20000);
    expect(p).toMatch(/\.\.\.\[truncated\]/);
  });

  it('gracefully handles missing error fields', () => {
    const p = buildFixPrompt({
      fileName: 't.ts',
      specCode: 'x',
      errorMessage: null,
      errorStack: null,
    });
    expect(p).toMatch(/no message/);
    expect(p).toMatch(/no stack/);
  });
});

describe('FIX_SYSTEM_PROMPT', () => {
  it('asks for JSON-only output (so JSON mode is enforceable)', () => {
    expect(FIX_SYSTEM_PROMPT).toMatch(/JSON ONLY/);
    expect(FIX_SYSTEM_PROMPT).toMatch(/newCode/);
    expect(FIX_SYSTEM_PROMPT).toMatch(/explanation/);
  });
});
