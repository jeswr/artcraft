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
 * default says "as the dev build would"; Rust is the authority).
 */
export function parseOrigin(value: unknown, allowLoopback = true): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value) return null;
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    return allowLoopback && (url.protocol === 'https:' || url.protocol === 'http:') ? value : null;
  }
  return url.protocol === 'https:' && isPublicDnsHost(url.hostname) ? value : null;
}

function isPublicDnsHost(host: string): boolean {
  if (host.length > 253) return false;
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
  const i = parseOrigin(issuer);
  if (i === null) return null;
  if (storage === undefined) return { issuer: i };
  const s = parseOrigin(storage);
  if (s === null) return null;
  return { issuer: i, storage: s };
}
