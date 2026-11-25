import { type PodOrigins, parseOrigin } from './origins.js';

/**
 * Hosts the static CSP in crates/desktop/artcraft/tauri*.conf.json admits in connect-src,
 * minus the analytics hosts (clarity.ms, google-analytics.com, googletagmanager.com), which
 * pod mode never loads. Includes the Tauri IPC and asset schemes the app needs.
 */
export const HOSTED_CONNECT_SOURCES: readonly string[] = [
  'asset:',
  'blob:',
  'data:',
  'http://ipc.localhost',
  'https://*.fakeyou.com',
  'https://*.storyteller.ai',
  'https://asset.localhost',
  'https://unpkg.com/detect-gpu@5.0.70/',
  'ipc://localhost',
  'tauri://localhost',
];

// Sources for default-src, img-src and media-src: the static default-src without the analytics
// hosts and without 'unsafe-eval'/'unsafe-inline', plus the asset protocol for local files.
// Deliberately not `*`: the static img-src is `*`, which is an exfiltration channel.
const HOSTED_CONTENT_SOURCES: readonly string[] = [
  "'self'",
  'asset:',
  'blob:',
  'data:',
  'https://*.fakeyou.com',
  'https://*.storyteller.ai',
  'https://asset.localhost',
  'ipc://localhost',
  'tauri://localhost',
];

// A source expression: scheme-only (`blob:`), or scheme://[*.]host[:port][/path/]. No
// whitespace, ';' or ',' possible by construction.
const SOURCE = /^(?:[a-z][a-z0-9+.-]*:|[a-z][a-z0-9+.-]*:\/\/(?:\*\.)?[a-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9@._~/-]*)?)$/;

/**
 * Narrowing policy for a <meta http-equiv="Content-Security-Policy">. Meta policies are
 * intersected with the static policy, so this can only restrict. Throws on any origin or host
 * that is not strictly serialised. No directive here falls through to a wider static value:
 * default-src, style-src, font-src, img-src, media-src and connect-src are all explicit.
 */
export function buildPodModeCsp(origins: Partial<PodOrigins>, hostedHosts: readonly string[]): string {
  const hosts = hostedHosts.map((h) => {
    if (!SOURCE.test(h)) throw new Error(`buildPodModeCsp: invalid host source ${JSON.stringify(h)}`);
    return h;
  });
  const extra: string[] = [];
  if (origins.issuer !== undefined) {
    const i = parseOrigin(origins.issuer);
    if (i === null) throw new Error('buildPodModeCsp: invalid issuer origin');
    extra.push(i);
  }
  if (origins.storage !== undefined) {
    const s = parseOrigin(origins.storage);
    if (s === null) throw new Error('buildPodModeCsp: invalid storage origin');
    extra.push(s);
  }
  const connect = Array.from(new Set(["'self'", ...hosts, ...extra]));
  const content = HOSTED_CONTENT_SOURCES.join(' ');
  return [
    `default-src ${content}`,
    "script-src 'self' 'wasm-unsafe-eval'",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `img-src ${content}`,
    `media-src ${content}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-src 'none'",
    `connect-src ${connect.join(' ')}`,
  ].join('; ');
}
