/**
 * `unavailable`: the server failed or timed out (try later). `network`: the request itself
 * was refused or blocked before any answer (offline, or the browser's CORS rule). `gone`: the
 * server answered with a client error such as 404. `too-large` and `bad-url` never change.
 */
export type BytesErrorKind = 'too-large' | 'unavailable' | 'network' | 'gone' | 'bad-url';

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
  /** Gives up on one download after this long (it counts as `unavailable`). */
  timeoutMs?: number;
}

/** Downloads a public address without credentials. Rejects with a {@link BytesError}. */
export type FetchPublicBytes = (url: string, options: FetchBytesOptions) => Promise<Blob>;

/**
 * Reads a response body in chunks into a `Blob` and stops as soon as it passes `maxBytes`. The
 * chunks are handed to the `Blob` without being joined, so no second full copy is made here.
 */
export async function readBounded(response: Response, maxBytes: number): Promise<Blob> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => undefined);
    throw new BytesError('too-large');
  }
  if (!response.body) {
    const whole = await response.blob();
    if (whole.size > maxBytes) throw new BytesError('too-large');
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
  return new Blob(chunks as BlobPart[]);
}

/**
 * Bounds the bytes being uploaded at once. The upload step costs several times a file's size
 * (the SDK store reads the whole body once to hash it, and the authenticated `fetch` may buffer
 * it again), so what is bounded is the bytes, not the number of items. An item larger than the
 * whole budget still runs, alone.
 */
export class ByteBudget {
  private used = 0;
  private readonly waiting: { bytes: number; grant: () => void }[] = [];

  constructor(readonly capacity: number) {}

  /** Resolves with a release function once `bytes` fit (or nothing else holds any). Rejects on abort. */
  acquire(bytes: number, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new DOMException('aborted', 'AbortError'));
    return new Promise((resolve, reject) => {
      const entry = {
        bytes,
        grant: () => {
          signal?.removeEventListener('abort', onAbort);
          this.used += bytes;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.used -= bytes;
            this.admit();
          });
        },
      };
      const onAbort = () => {
        const at = this.waiting.indexOf(entry);
        if (at >= 0) this.waiting.splice(at, 1);
        reject(new DOMException('aborted', 'AbortError'));
        this.admit();
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
      this.admit();
    });
  }

  /** Bytes currently held. */
  get inFlight(): number {
    return this.used;
  }

  private admit(): void {
    // First come, first served: a large item at the head is not overtaken forever by small ones.
    for (;;) {
      const next = this.waiting[0];
      if (!next || (this.used > 0 && this.used + next.bytes > this.capacity)) return;
      this.waiting.shift();
      next.grant();
    }
  }
}

/** The first `length` bytes of a `Blob`, for sniffing. */
export async function blobHead(blob: Blob, length = 4096): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(0, length).arrayBuffer());
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

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Plain `fetch` with no credentials, referrer or cookies, for the hosted CDN's public files.
 * It is the only way bytes are fetched: there is no fallback through the app's own network layer.
 */
export function createPublicBytesFetcher(options: { fetch?: typeof fetch } = {}): FetchPublicBytes {
  return async (url, { maxBytes, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) => {
    if (!isPublicHttpsUrl(url)) throw new BytesError('bad-url');
    const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const failure = (): BytesError => (timeout.aborted && !signal?.aborted ? new BytesError('unavailable') : new BytesError('network'));
    let response: Response;
    try {
      response = await doFetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow', signal: combined });
    } catch {
      throw failure();
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      const retryable = response.status >= 500 || response.status === 429 || response.status === 408;
      throw new BytesError(retryable ? 'unavailable' : 'gone');
    }
    try {
      return await readBounded(response, maxBytes);
    } catch (error) {
      if (error instanceof BytesError) throw error;
      throw failure();
    }
  };
}
