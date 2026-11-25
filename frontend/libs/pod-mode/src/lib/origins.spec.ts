import { describe, expect, it } from 'vitest';
import { parseOrigin, validatePodOrigins } from './origins.js';

describe('parseOrigin', () => {
  it.each([
    'https://id.example',
    'https://id.example:8443',
    'http://localhost',
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ])('accepts %s', (o) => expect(parseOrigin(o)).toBe(o));

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
