export type BytesErrorKind = 'too-large' | 'unavailable' | 'bad-url';

/** A failed byte download. Carries a closed kind only, never a URL or a server message. */
export class BytesError extends Error {
  constructor(readonly kind: BytesErrorKind) {
    super(kind);
    this.name = 'BytesError';
  }
}

export interface FetchBytesOptions {
  /** Largest body accepted; a longer one fails as `too-large` without being buffered whole. */
  maxBytes: number;
  signal?: AbortSignal;
}

/** Downloads a public address without credentials. Rejects with a {@link BytesError}. */
export type FetchPublicBytes = (url: string, options: FetchBytesOptions) => Promise<Uint8Array>;

/** Reads a response body in chunks and stops as soon as it passes `maxBytes`. */
export async function readBounded(response: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new BytesError('too-large');
  }
  if (!response.body) {
    const whole = new Uint8Array(await response.arrayBuffer());
    if (whole.byteLength > maxBytes) throw new BytesError('too-large');
    return whole;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      void reader.cancel().catch(() => undefined);
      throw new BytesError('too-large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** An https address with no credentials in it. */
export function isPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/**
 * Plain `fetch` with no credentials, referrer or cookies, for the hosted CDN's public files.
 * The app may wrap it with a fallback that loads bytes only (never pod traffic) another way.
 */
export function createPublicBytesFetcher(options: { fetch?: typeof fetch } = {}): FetchPublicBytes {
  return async (url, { maxBytes, signal }) => {
    if (!isPublicHttpsUrl(url)) throw new BytesError('bad-url');
    const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    let response: Response;
    try {
      response = await doFetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', signal });
    } catch {
      throw new BytesError('unavailable');
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new BytesError('unavailable');
    }
    try {
      return await readBounded(response, maxBytes);
    } catch (error) {
      if (error instanceof BytesError) throw error;
      throw new BytesError('unavailable');
    }
  };
}
