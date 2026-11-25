import { parseOrigin } from '@storyteller/pod-mode';

/**
 * Turns what the user typed into an origin, or null. Only a bare https origin is accepted,
 * with an optional trailing slash; `http://localhost` and `http://127.0.0.1` only when
 * `allowLoopbackHttp` (a dev build). Credentials, paths, queries, fragments, other schemes and
 * anything `parseOrigin` refuses are rejected, not repaired. This is a shape check; whether
 * the origin is an identity provider is decided by pod-auth's discovery, and the app asks the
 * person to confirm the origin in its own dialog before anything leaves the device.
 */
export function parseIssuerInput(input: unknown, allowLoopbackHttp = false): string | null {
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text.length === 0 || text.length > 255) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' && !allowLoopbackHttp) return null;
  if (url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') return null;
  if (url.pathname !== '/' || /[?#]/.test(text)) return null;
  if (text.replace(/\/$/, '').toLowerCase() !== url.origin) return null;
  return parseOrigin(url.origin);
}

/** What the person typed: a provider address, or the WebID that names their profile. */
export type SignInInput =
  | { kind: 'issuer'; issuer: string; origin: string }
  | { kind: 'webid'; webId: string; origin: string };

/**
 * A provider address (a bare https origin, as `parseIssuerInput`) or a WebID: an https URL with
 * a path or a fragment, no credentials and no query. Either way `origin` is what the app is
 * asked to confirm first; for a WebID it is the origin of the profile, which the window must be
 * able to reach before pod-auth can read it. Nothing is fetched here.
 */
export function parseSignInInput(input: unknown, allowLoopbackHttp = false): SignInInput | null {
  const issuer = parseIssuerInput(input, allowLoopbackHttp);
  if (issuer !== null) return { kind: 'issuer', issuer, origin: issuer };
  if (typeof input !== 'string') return null;
  const text = input.trim();
  if (text.length === 0 || text.length > 2048) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' && !allowLoopbackHttp) return null;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username !== '' || url.password !== '' || url.search !== '' || /[?\s]/.test(text)) return null;
  if (url.pathname === '/' && url.hash === '') return null;
  const origin = parseOrigin(url.origin);
  return origin === null ? null : { kind: 'webid', webId: url.href, origin };
}
