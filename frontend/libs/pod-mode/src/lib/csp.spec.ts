import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildPodModeCsp, HOSTED_CONNECT_SOURCES } from './csp.js';

const directives = (csp: string) =>
  Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1)]));

describe('buildPodModeCsp', () => {
  // The one exact snapshot: this string is a security policy and a change should be deliberate.
  it('exact policy with both origins', () => {
    expect(
      buildPodModeCsp({ issuer: 'https://id.example', storage: 'https://pod.example' }, HOSTED_CONNECT_SOURCES),
    ).toBe(
      "default-src 'self' asset: blob: data: https://*.fakeyou.com https://*.storyteller.ai https://asset.localhost ipc://localhost tauri://localhost; " +
        "script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; " +
        "img-src 'self' asset: blob: data: https://*.fakeyou.com https://*.storyteller.ai https://asset.localhost ipc://localhost tauri://localhost; " +
        "media-src 'self' asset: blob: data: https://*.fakeyou.com https://*.storyteller.ai https://asset.localhost ipc://localhost tauri://localhost; " +
        "object-src 'none'; base-uri 'self'; form-action 'none'; frame-src 'none'; " +
        "connect-src 'self' asset: blob: data: http://ipc.localhost https://*.fakeyou.com https://*.storyteller.ai https://asset.localhost " +
        'https://unpkg.com/detect-gpu@5.0.70/ ipc://localhost tauri://localhost https://id.example https://pod.example',
    );
  });

  it('sets every fetch-type directive explicitly and none is a wildcard or https:', () => {
    const d = directives(buildPodModeCsp({ issuer: 'https://id.example' }, HOSTED_CONNECT_SOURCES));
    for (const name of ['default-src', 'script-src', 'worker-src', 'style-src', 'font-src', 'img-src', 'media-src', 'connect-src']) {
      expect(d[name], name).toBeDefined();
      expect(d[name]).not.toContain('*');
      expect(d[name]).not.toContain('https:');
      expect(d[name]).not.toContain("'unsafe-eval'");
    }
    expect(d['script-src']).not.toContain("'unsafe-inline'");
  });

  it('names no analytics or font host anywhere', () => {
    const csp = buildPodModeCsp({ issuer: 'https://id.example' }, HOSTED_CONNECT_SOURCES);
    for (const bad of ['clarity', 'google-analytics', 'googletagmanager', 'googleapis', 'gstatic']) {
      expect(csp).not.toContain(bad);
    }
  });

  it('adds the issuer and storage origins to connect-src only', () => {
    const d = directives(buildPodModeCsp({ issuer: 'https://id.example', storage: 'https://pod.example' }, []));
    expect(d['connect-src']).toEqual(["'self'", 'https://id.example', 'https://pod.example']);
    for (const name of ['default-src', 'img-src', 'media-src', 'script-src']) {
      expect(d[name].join(' ')).not.toContain('example');
    }
  });

  it('admits several storage origins, in order, to connect-src only', () => {
    const d = directives(
      buildPodModeCsp({ issuer: 'https://id.example', storage: ['https://pod1.example', 'https://pod2.example:8443', 'https://pod1.example'] }, []),
    );
    expect(d['connect-src']).toEqual(["'self'", 'https://id.example', 'https://pod1.example', 'https://pod2.example:8443']);
    expect(d['img-src'].join(' ')).not.toContain('pod');
  });

  it('refuses one bad origin in a list', () => {
    expect(() => buildPodModeCsp({ storage: ['https://pod1.example', 'https://pod2.example/path'] }, [])).toThrow();
  });

  it('deduplicates a storage origin equal to the issuer', () => {
    const csp = buildPodModeCsp({ issuer: 'https://id.example', storage: 'https://id.example' }, []);
    expect(csp.match(/https:\/\/id\.example/g)).toHaveLength(1);
  });

  it.each([
    { issuer: 'https://a.example; script-src *' },
    { issuer: 'https://a.example', storage: 'https://b.example, https://c.example' },
    { issuer: "https://a.example'" },
    { issuer: 'https://a.example/path' },
    { issuer: 'https://a.example', storage: 'https://b.example b' },
  ])('rejects hostile origins %j', (o) => expect(() => buildPodModeCsp(o, [])).toThrow());

  it.each(['https://a.example; script-src *', 'a b', 'https://a.example,https://b.example', "'unsafe-inline'", '', '*'])(
    'rejects hostile host %j',
    (h) => expect(() => buildPodModeCsp({}, [h])).toThrow(),
  );
});

describe('HOSTED_CONNECT_SOURCES vs the static CSP', () => {
  const ANALYTICS = [/clarity\.ms$/, /google-analytics\.com$/, /googletagmanager\.com$/];
  const dir = resolve(__dirname, '../../../../../crates/desktop/artcraft');

  it.each(['tauri.conf.json', 'tauri-mac.conf.json', 'tauri-dev-hot-reload.conf.json'])(
    '%s connect-src minus analytics equals the hosted list',
    (file) => {
      const conf = JSON.parse(readFileSync(resolve(dir, file), 'utf8'));
      const staticSources: string[] = conf.app.security.csp['connect-src'];
      const expected = staticSources
        .filter((s) => !s.startsWith("'"))
        .filter((s) => !ANALYTICS.some((re) => re.test(s)))
        .sort();
      expect([...HOSTED_CONNECT_SOURCES].sort()).toEqual(expected);
    },
  );
});
