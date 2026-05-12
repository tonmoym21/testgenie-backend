const cookieJar = require('../src/automation/cookieJar');

describe('cookieJar', () => {
  it('ingests Set-Cookie and returns it on cookieHeaderFor for the same origin', async () => {
    const jar = cookieJar.createJar();
    await cookieJar.ingestSetCookies(jar, 'https://api.example.com/login', [
      'session=abc123; Path=/; HttpOnly',
    ]);
    const header = await cookieJar.cookieHeaderFor(jar, 'https://api.example.com/users');
    expect(header).toBe('session=abc123');
  });

  it('respects Path scoping', async () => {
    const jar = cookieJar.createJar();
    await cookieJar.ingestSetCookies(jar, 'https://api.example.com/admin/login', [
      'adminToken=xyz; Path=/admin',
    ]);
    expect(await cookieJar.cookieHeaderFor(jar, 'https://api.example.com/admin/users')).toBe('adminToken=xyz');
    expect(await cookieJar.cookieHeaderFor(jar, 'https://api.example.com/public')).toBe('');
  });

  it('respects Domain scoping — does not leak to other hosts', async () => {
    const jar = cookieJar.createJar();
    await cookieJar.ingestSetCookies(jar, 'https://api.example.com/', [
      'token=secret; Path=/',
    ]);
    expect(await cookieJar.cookieHeaderFor(jar, 'https://evil.com/')).toBe('');
  });

  it('skips Secure cookies over http', async () => {
    const jar = cookieJar.createJar();
    await cookieJar.ingestSetCookies(jar, 'https://api.example.com/', [
      'auth=v1; Path=/; Secure',
    ]);
    expect(await cookieJar.cookieHeaderFor(jar, 'http://api.example.com/')).toBe('');
    expect(await cookieJar.cookieHeaderFor(jar, 'https://api.example.com/')).toBe('auth=v1');
  });

  it('overwrites cookies with the same name+domain+path', async () => {
    const jar = cookieJar.createJar();
    await cookieJar.ingestSetCookies(jar, 'https://api.example.com/', ['s=1; Path=/']);
    await cookieJar.ingestSetCookies(jar, 'https://api.example.com/', ['s=2; Path=/']);
    expect(await cookieJar.cookieHeaderFor(jar, 'https://api.example.com/')).toBe('s=2');
  });

  it('tolerates malformed Set-Cookie strings without throwing', async () => {
    const jar = cookieJar.createJar();
    await expect(
      cookieJar.ingestSetCookies(jar, 'https://api.example.com/', [
        '',
        'no-equals-sign',
        'good=cookie; Path=/',
      ])
    ).resolves.toBeUndefined();
    expect(await cookieJar.cookieHeaderFor(jar, 'https://api.example.com/')).toContain('good=cookie');
  });

  it('snapshot returns a serialisable cookie list with metadata', async () => {
    const jar = cookieJar.createJar();
    await cookieJar.ingestSetCookies(jar, 'https://api.example.com/', [
      'token=v1; Path=/; Secure; HttpOnly',
    ]);
    const snap = await cookieJar.snapshot(jar);
    expect(Array.isArray(snap)).toBe(true);
    const found = snap.find((c) => c.name === 'token');
    expect(found).toBeTruthy();
    expect(found.value).toBe('v1');
    expect(found.secure).toBe(true);
    expect(found.httpOnly).toBe(true);
    // metadata should JSON-serialise cleanly
    expect(() => JSON.stringify(snap)).not.toThrow();
  });

  it('two jars are isolated', async () => {
    const a = cookieJar.createJar();
    const b = cookieJar.createJar();
    await cookieJar.ingestSetCookies(a, 'https://api.example.com/', ['t=A; Path=/']);
    await cookieJar.ingestSetCookies(b, 'https://api.example.com/', ['t=B; Path=/']);
    expect(await cookieJar.cookieHeaderFor(a, 'https://api.example.com/')).toBe('t=A');
    expect(await cookieJar.cookieHeaderFor(b, 'https://api.example.com/')).toBe('t=B');
  });

  it('returns empty string / empty list for null jar', async () => {
    expect(await cookieJar.cookieHeaderFor(null, 'https://x/')).toBe('');
    expect(await cookieJar.snapshot(null)).toEqual([]);
  });
});
