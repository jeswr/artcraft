import { describe, expect, it } from 'vitest';
import { parseIssuerInput } from './issuer.js';

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
