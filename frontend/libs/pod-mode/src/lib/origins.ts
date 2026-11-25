export type PodOrigins = {
  issuer: string;
  storage?: string;
};

/**
 * Returns `value` when it is exactly an origin: https, or http for localhost / 127.0.0.1 only,
 * with a host of `[a-z0-9.-]` (what a browser accepts as a CSP source). `new URL(value).origin`
 * must equal `value`, which rejects paths, queries, fragments, userinfo, trailing slashes,
 * default ports, upper case and IDN forms. Returns null otherwise.
 */
export function parseOrigin(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > 255) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.origin !== value) return null;
  if (!/^[a-z0-9.-]+$/.test(url.hostname)) return null;
  if (url.protocol === 'https:') return value;
  if (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')) {
    return value;
  }
  return null;
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
