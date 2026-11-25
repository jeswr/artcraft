import { describe, expect, it } from 'vitest';
import { parseIssuerInput, parseSignInInput } from './issuer.js';

describe('parseIssuerInput', () => {
  it.each([
    ['https://login.example', 'https://login.example'],
    ['  https://login.example/ ', 'https://login.example'],
    ['https://login.example:8443', 'https://login.example:8443'],
  ])('accepts %j as an origin', (input, origin) => {
    expect(parseIssuerInput(input)).toBe(origin);
  });

  it('refuses http://localhost unless a dev build allows it', () => {
    expect(parseIssuerInput('http://localhost:3000/')).toBeNull();
    expect(parseIssuerInput('http://127.0.0.1:3000', false)).toBeNull();
    expect(parseIssuerInput('http://localhost:3000/', true)).toBe('http://localhost:3000');
    expect(parseIssuerInput('http://login.example', true)).toBeNull();
  });

  it.each([
    '',
    '   ',
    'login.example',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'ftp://login.example',
    'http://login.example',
    'https://user:secret@login.example',
    'https://login.example@evil.example',
    'https://login.example/path',
    'https://login.example/?next=1',
    'https://login.example/#frag',
    'https://login.example\n.evil.example',
    'https://login.example\u0000',
    'https://[::1]/',
    'https://login.example:443@evil.example',
    `https://${'a'.repeat(300)}.example`,
    '"https://login.example"',
  ])('refuses %j', (input) => {
    expect(parseIssuerInput(input)).toBeNull();
  });

  it('refuses values that are not strings', () => {
    for (const value of [undefined, null, 5, {}, ['https://login.example']]) {
      expect(parseIssuerInput(value)).toBeNull();
    }
  });
});

describe('parseSignInInput', () => {
  it('treats a bare origin as a provider address', () => {
    expect(parseSignInInput(' https://login.example/ ')).toEqual({ kind: 'issuer', issuer: 'https://login.example', origin: 'https://login.example' });
  });

  it.each([
    ['https://pod.example/alice/profile/card#me', 'https://pod.example'],
    ['https://pod.example/alice', 'https://pod.example'],
    ['https://pod.example/#me', 'https://pod.example'],
    ['https://pod.example:8443/card#me', 'https://pod.example:8443'],
  ])('treats %j as a WebID on %j', (input, origin) => {
    expect(parseSignInInput(input)).toEqual({ kind: 'webid', webId: input, origin });
  });

  it.each([
    '',
    '   ',
    'pod.example/card#me',
    'javascript:alert(1)',
    'https://u:p@pod.example/card#me',
    'https://pod.example/card?x=1',
    'https://pod.example/card #me',
    'http://pod.example/card#me',
    'ftp://pod.example/card',
    `https://pod.example/${'a'.repeat(2100)}`,
  ])('refuses %j', (input) => {
    expect(parseSignInInput(input)).toBeNull();
  });

  it('refuses what is not text', () => {
    expect(parseSignInInput(null)).toBeNull();
    expect(parseSignInInput(42)).toBeNull();
  });

  it('accepts a loopback http WebID only when the build allows it', () => {
    expect(parseSignInInput('http://localhost:3000/alice#me')).toBeNull();
    expect(parseSignInInput('http://localhost:3000/alice#me', true)).toEqual({ kind: 'webid', webId: 'http://localhost:3000/alice#me', origin: 'http://localhost:3000' });
    expect(parseSignInInput('http://pod.example/alice#me', true)).toBeNull();
  });
});
