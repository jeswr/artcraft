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
