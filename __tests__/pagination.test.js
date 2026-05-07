// Pure-function tests for parseListPagination — no DB, no app bootstrap.

const { parseListPagination, DEFAULT_LIMIT, MAX_LIMIT } = require('../src/utils/pagination');

describe('parseListPagination', () => {
  describe('defaults', () => {
    it('returns sane defaults when query is empty', () => {
      expect(parseListPagination({})).toEqual({
        page: 1,
        limit: DEFAULT_LIMIT,
        offset: 0,
      });
    });

    it('returns defaults when query is undefined', () => {
      expect(parseListPagination()).toEqual({
        page: 1,
        limit: DEFAULT_LIMIT,
        offset: 0,
      });
    });
  });

  describe('parsing', () => {
    it('parses string page and limit (typical query-string source)', () => {
      const r = parseListPagination({ page: '3', limit: '25' });
      expect(r).toEqual({ page: 3, limit: 25, offset: 50 });
    });

    it('accepts numeric page and limit', () => {
      const r = parseListPagination({ page: 2, limit: 10 });
      expect(r).toEqual({ page: 2, limit: 10, offset: 10 });
    });
  });

  describe('clamping', () => {
    it('clamps limit to maxLimit (default 100)', () => {
      const r = parseListPagination({ limit: 9999 });
      expect(r.limit).toBe(MAX_LIMIT);
    });

    it('respects custom maxLimit option', () => {
      const r = parseListPagination({ limit: 9999 }, { maxLimit: 500 });
      expect(r.limit).toBe(500);
    });

    it('respects custom defaultLimit option when limit absent', () => {
      const r = parseListPagination({}, { defaultLimit: 20 });
      expect(r.limit).toBe(20);
    });

    it('floors page at 1 for non-positive values', () => {
      expect(parseListPagination({ page: 0 }).page).toBe(1);
      expect(parseListPagination({ page: -5 }).page).toBe(1);
    });

    it('floors limit at 1', () => {
      expect(parseListPagination({ limit: 0 }).limit).toBeGreaterThanOrEqual(1);
      expect(parseListPagination({ limit: -10 }).limit).toBeGreaterThanOrEqual(1);
    });
  });

  describe('garbage input', () => {
    it('falls back to defaults for non-numeric strings', () => {
      const r = parseListPagination({ page: 'abc', limit: 'xyz' });
      expect(r).toEqual({ page: 1, limit: DEFAULT_LIMIT, offset: 0 });
    });

    it('falls back to defaults for null / undefined fields', () => {
      const r = parseListPagination({ page: null, limit: undefined });
      expect(r.page).toBe(1);
      expect(r.limit).toBe(DEFAULT_LIMIT);
    });

    it('handles fractional limits by truncating to int', () => {
      const r = parseListPagination({ limit: '12.7' });
      expect(r.limit).toBe(12);
    });
  });

  describe('offset arithmetic', () => {
    it('computes offset as (page - 1) * limit using the clamped limit', () => {
      const r = parseListPagination({ page: 3, limit: 9999 }, { maxLimit: 100 });
      expect(r.limit).toBe(100);
      expect(r.offset).toBe(200);
    });
  });
});
