import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildAllowsLoopback, parseOrigin, validatePodOrigins } from './origins.js';

describe('parseOrigin', () => {
  it.each(['https://id.example', 'https://id.example:8443'])('accepts %s', (o) => expect(parseOrigin(o)).toBe(o));

  it.each(['http://localhost', 'http://localhost:3000', 'http://127.0.0.1:3000', 'https://localhost'])(
    'accepts %s only where the build allows loopback, and by default does not',
    (o) => {
      expect(parseOrigin(o, true)).toBe(o);
      expect(parseOrigin(o)).toBeNull();
      expect(parseOrigin(o, false)).toBeNull();
    },
  );

  it.each([
    'https://foo.localhost',
    'https://foo.local',
    'https://router.lan',
    'https://a.internal',
    'https://x.home.arpa',
    'https://a.onion',
    'https://a.test',
    'https://a.invalid',
    'https://id.example:0',
  ])('refuses %s even where loopback is allowed', (o) => {
    expect(parseOrigin(o, true)).toBeNull();
    expect(parseOrigin(o, false)).toBeNull();
  });

  it('knows whether the build allows loopback from the same two variables as the config', () => {
    expect(buildAllowsLoopback({ VITE_SOLID_ALLOW_LOOPBACK: 'true', DEV: true })).toBe(true);
    expect(buildAllowsLoopback({ VITE_SOLID_ALLOW_LOOPBACK: 'true', DEV: false })).toBe(false);
    expect(buildAllowsLoopback({ DEV: true })).toBe(false);
    expect(buildAllowsLoopback({})).toBe(false);
  });

  it.each([
    '',
    'http://id.example',
    'http://localhost.evil.example',
    'http://[::1]:3000',
    'https://[::1]',
    'ftp://id.example',
    'javascript:alert(1)',
    'https://id.example/',
    'https://id.example/path',
    'https://id.example?x=1',
    'https://id.example#x',
    'https://user@id.example',
    'https://id.example;',
    'https://id.example; script-src *',
    'https://id.example, https://evil.example',
    'https://id.example https://evil.example',
    ' https://id.example',
    'https://id.example\n',
    "https://id.example'",
    'https://id."example',
    'https://*.example',
    'https://ID.example',
    'https://id.example:443',
    'https://bücher.example',
    'https://a_b.example',
    'https://a!b.example',
    'https://id.example\u0000',
    '*',
    'https:',
    'blob:',
  ])('rejects %j', (o) => expect(parseOrigin(o)).toBeNull());

  it('rejects overlong values that are otherwise valid', () => {
    const long = `https://${'a'.repeat(250)}.example`;
    expect(new URL(long).origin).toBe(long);
    expect(parseOrigin(long)).toBeNull();
    expect(parseOrigin(`https://${'a'.repeat(60)}.example`)).not.toBeNull();
  });

  it('rejects non-strings', () => {
    for (const v of [null, undefined, 1, {}, ['https://a.example']]) expect(parseOrigin(v)).toBeNull();
  });
});

describe('validatePodOrigins', () => {
  it('requires a valid issuer and, when present, a valid storage', () => {
    expect(validatePodOrigins({ issuer: 'https://a.example' })).toEqual({ issuer: 'https://a.example' });
    expect(validatePodOrigins({ issuer: 'https://a.example', storage: 'https://b.example' })).toEqual({
      issuer: 'https://a.example',
      storage: 'https://b.example',
    });
    expect(validatePodOrigins({ storage: 'https://b.example' })).toBeNull();
    expect(validatePodOrigins({ issuer: 'https://a.example', storage: 'nope' })).toBeNull();
    expect(validatePodOrigins(null)).toBeNull();
  });
});

describe('the validator shared with the Rust twin', () => {
  type Vector = { origin: string; valid_release: boolean; valid_dev: boolean };
  const { vectors } = JSON.parse(
    readFileSync(resolve(__dirname, '../../../../../crates/lib/pod_mode/testdata/origin-vectors.json'), 'utf8'),
  ) as { vectors: Vector[] };

  it('reads the same table as `cargo test -p pod_mode`', () => expect(vectors.length).toBeGreaterThan(40));

  it.each(vectors.map((v) => [JSON.stringify(v.origin), v] as const))('gets the same answer for %s', (_name, v) => {
    expect(parseOrigin(v.origin, false) !== null).toBe(v.valid_release);
    expect(parseOrigin(v.origin, true) !== null).toBe(v.valid_dev);
  });
});
