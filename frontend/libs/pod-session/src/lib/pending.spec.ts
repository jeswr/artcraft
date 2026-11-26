import { describe, expect, it } from 'vitest';
import { localStoragePending, localStorageSignedIn, originOfHint } from './pending.js';

function storage(initial?: string) {
  const data = new Map<string, string>(initial === undefined ? [] : [['artcraft.podSession.pending', initial]]);
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe('originOfHint', () => {
  it('is the origin of the typed address', () => {
    expect(originOfHint({ kind: 'issuer', issuer: 'https://login.example/' })).toBe('https://login.example');
    expect(originOfHint({ kind: 'webid', webId: 'https://pod.example/alice#me' })).toBe('https://pod.example');
  });
  it('is null for what is not an origin pod mode accepts', () => {
    expect(originOfHint({ kind: 'issuer', issuer: 'nope' })).toBeNull();
    expect(originOfHint({ kind: 'issuer', issuer: 'http://login.example' })).toBeNull();
  });
});

describe('localStoragePending', () => {
  it('round-trips a hint and the approved origin, and nothing else', () => {
    const s = storage();
    const store = localStoragePending(s);
    store.set({ hint: { kind: 'webid', webId: 'https://pod.example/alice#me' }, origin: 'https://pod.example' });
    expect(store.get()).toEqual({ hint: { kind: 'webid', webId: 'https://pod.example/alice#me' }, origin: 'https://pod.example' });
    expect(JSON.parse([...s.data.values()][0]!)).toEqual({ hint: { kind: 'webid', webId: 'https://pod.example/alice#me' }, origin: 'https://pod.example' });
    store.set(null);
    expect(store.get()).toBeNull();
    expect(s.data.size).toBe(0);
  });

  it.each([
    'not json',
    'null',
    '[]',
    '{}',
    '{"hint":null}',
    '{"hint":{"kind":"webid","webId":"javascript:alert(1)"}}',
    '{"hint":{"kind":"webid","webId":"https://pod.example/a?token=x"}}',
    '{"hint":{"kind":"issuer","issuer":"https://pod.example/path"}}',
    '{"hint":{"kind":"issuer","issuer":"https://login.example"},"origin":"http://evil.example"}',
    '{"hint":{"kind":"other","issuer":"https://login.example"}}',
    '{"hint":{"kind":"issuer","issuer":7}}',
  ])('reads %s as nothing', (raw) => {
    expect(localStoragePending(storage(raw)).get()).toBeNull();
  });

  it('keeps only the fields it knows from a tampered value', () => {
    const raw = '{"hint":{"kind":"issuer","issuer":"https://login.example","token":"secret"},"origin":"https://login.example","code":"x"}';
    expect(localStoragePending(storage(raw)).get()).toEqual({ hint: { kind: 'issuer', issuer: 'https://login.example' }, origin: 'https://login.example' });
  });

  it('allows a loopback http hint only when the build does', () => {
    const raw = '{"hint":{"kind":"issuer","issuer":"http://localhost:3000"}}';
    expect(localStoragePending(storage(raw)).get()).toBeNull();
    expect(localStoragePending(storage(raw), true)?.get()).toEqual({ hint: { kind: 'issuer', issuer: 'http://localhost:3000' } });
  });

  it('tolerates storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    const store = localStoragePending(broken);
    expect(() => store.set({ hint: { kind: 'issuer', issuer: 'https://login.example' } })).not.toThrow();
    expect(() => store.set(null)).not.toThrow();
    expect(store.get()).toBeNull();
  });
});

describe('the purpose of an approval', () => {
  const base = '{"hint":{"kind":"webid","webId":"https://pod.example/alice#me"},"origin":"https://id.example"';
  it('keeps one of the four words and drops anything else', () => {
    expect(localStoragePending(storage(`${base},"purpose":"sign-in"}`)).get()).toEqual({
      hint: { kind: 'webid', webId: 'https://pod.example/alice#me' },
      origin: 'https://id.example',
      purpose: 'sign-in',
    });
    for (const purpose of ['"nope"', '7', 'null']) {
      expect(localStoragePending(storage(`${base},"purpose":${purpose}}`)).get()).toEqual({
        hint: { kind: 'webid', webId: 'https://pod.example/alice#me' },
        origin: 'https://id.example',
      });
    }
  });

  it('refuses an origin the build would not allow, such as localhost in a release build', () => {
    const raw = '{"hint":{"kind":"issuer","issuer":"https://login.example"},"origin":"https://localhost"}';
    expect(localStoragePending(storage(raw)).get()).toBeNull();
    expect(localStoragePending(storage(raw), true).get()).not.toBeNull();
  });

  it('reads the origin of a hint with the build’s loopback flag', () => {
    expect(originOfHint({ kind: 'issuer', issuer: 'http://localhost:3000' })).toBeNull();
    expect(originOfHint({ kind: 'issuer', issuer: 'http://localhost:3000' }, true)).toBe('http://localhost:3000');
  });
});

describe('localStorageSignedIn', () => {
  it('round-trips a hint and re-validates what page storage holds', () => {
    const s = storage();
    const store = localStorageSignedIn(s);
    store.set({ kind: 'webid', webId: 'https://pod.example/alice#me' });
    expect(store.get()).toEqual({ kind: 'webid', webId: 'https://pod.example/alice#me' });
    for (const raw of ['not json', '{"kind":"issuer","issuer":"http://login.example"}', '{"kind":"webid","webId":"https://u:p@pod.example/a"}']) {
      s.data.set('artcraft.podSession.signedIn', raw);
      expect(store.get()).toBeNull();
    }
    store.set(null);
    expect(s.data.size).toBe(0);
  });
});
