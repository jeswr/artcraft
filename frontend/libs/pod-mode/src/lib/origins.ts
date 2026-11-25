export type PodOrigins = {
  issuer: string;
  storage?: string;
};

/**
 * Returns `value` when it is exactly an origin that a CSP host source can name. This is the twin
 * of `parse_origin` in `crates/lib/pod_mode/src/origin.rs`; both are tested against
 * `crates/lib/pod_mode/testdata/origin-vectors.json`. https only, with a host of at least two
 * labels of `[a-z0-9-]` (no empty label, so no trailing dot; none starting or ending with `-`;
 * none starting with `xn--`), whose last label is not all digits (so no IPv4 literal).
 * `new URL(value).origin` must equal `value`, which rejects paths, queries, fragments, userinfo,
 * trailing slashes, default ports, upper case and IPv6 literals. `localhost` and `127.0.0.1`,
 * over https or http, are accepted only with `allowLoopback` (the app decides per build, so the
 * default is "not allowed", as a release build; callers pass the build's real value, see
 * `buildAllowsLoopback`; Rust is the authority). Port 0 and the special-use names (`*.localhost`,
 * `.local`, `.lan`, `.internal`, `.home.arpa`, `.onion`, `.test`, `.invalid`) are refused;
 * `.example` is allowed because the tests and the shared vectors use it, and it can never be
 * delegated. Internationalised host names are not supported yet.
 */
export function parseOrigin(value: unknown, allowLoopback = false): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value || url.port === '0') return null;
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return allowLoopback && (url.protocol === 'https:' || url.protocol === 'http:') ? value : null;
  }
  return url.protocol === 'https:' && isPublicDnsHost(url.hostname) ? value : null;
}

/**
 * Whether this build lets the page treat `localhost` / `127.0.0.1` as origins: a Vite dev run
 * with `VITE_SOLID_ALLOW_LOOPBACK=true`, the same rule `readConfig` uses. A release build never.
 */
export function buildAllowsLoopback(env: Record<string, unknown> = (import.meta as { env?: Record<string, unknown> }).env ?? {}): boolean {
  return env['VITE_SOLID_ALLOW_LOOPBACK'] === 'true' && env['DEV'] === true;
}

const SPECIAL_USE_SUFFIXES = ['localhost', 'local', 'lan', 'internal', 'home.arpa', 'onion', 'test', 'invalid'];

function isSpecialUse(host: string): boolean {
  return SPECIAL_USE_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

function isPublicDnsHost(host: string): boolean {
  if (host.length > 253 || isSpecialUse(host)) return false;
  const labels = host.split('.');
  if (labels.length < 2 || !labels.every(isDnsLabel)) return false;
  return !/^[0-9]+$/.test(labels[labels.length - 1] as string);
}

function isDnsLabel(label: string): boolean {
  return (
    label.length > 0 &&
    label.length <= 63 &&
    !label.startsWith('-') &&
    !label.endsWith('-') &&
    !label.startsWith('xn--') &&
    /^[a-z0-9-]+$/.test(label)
  );
}

export function validatePodOrigins(origins: unknown): PodOrigins | null {
  if (typeof origins !== 'object' || origins === null) return null;
  const { issuer, storage } = origins as Record<string, unknown>;
  const i = parseOrigin(issuer, buildAllowsLoopback());
  if (i === null) return null;
  if (storage === undefined) return { issuer: i };
  const s = parseOrigin(storage, buildAllowsLoopback());
  if (s === null) return null;
  return { issuer: i, storage: s };
}
