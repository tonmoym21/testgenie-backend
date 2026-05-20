// Pure-function tests for the unified diff renderer.

const { unifiedDiff } = require('../src/utils/unifiedDiff');

describe('unifiedDiff', () => {
  it('returns empty string when texts are identical', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'x.ts')).toBe('');
  });

  it('emits proper file headers', () => {
    const d = unifiedDiff('a\n', 'b\n', 'login.spec.ts');
    expect(d).toMatch(/^--- a\/login\.spec\.ts\n\+\+\+ b\/login\.spec\.ts\n/);
  });

  it('marks removed and added lines', () => {
    const d = unifiedDiff('foo\nbar\n', 'foo\nbaz\n', 't.ts');
    expect(d).toMatch(/-bar/);
    expect(d).toMatch(/\+baz/);
    expect(d).toMatch(/ foo/);
  });

  it('coalesces nearby changes into a single hunk', () => {
    const oldT = 'a\nb\nc\nd\ne\n';
    const newT = 'a\nB\nc\nD\ne\n';
    const d = unifiedDiff(oldT, newT, 't.ts');
    expect(d.match(/^@@/gm).length).toBe(1);
  });

  it('splits far-apart changes into separate hunks', () => {
    const oldT = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const newT = oldT.replace('line 1', 'LINE 1').replace('line 18', 'LINE 18');
    const d = unifiedDiff(oldT, newT, 't.ts');
    expect(d.match(/^@@/gm).length).toBe(2);
  });

  it('handles pure insertion', () => {
    const d = unifiedDiff('', 'hello\n', 'x');
    expect(d).toMatch(/\+hello/);
  });

  it('handles pure deletion', () => {
    const d = unifiedDiff('hello\n', '', 'x');
    expect(d).toMatch(/-hello/);
  });
});
