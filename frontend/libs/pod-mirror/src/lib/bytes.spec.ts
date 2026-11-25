import { describe, expect, it, vi } from 'vitest';
import { createPublicBytesFetcher, isPublicHttpsUrl, readBounded } from './bytes.js';

const streamOf = (chunks: Uint8Array[], headers: Record<string, string> = {}) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    { headers },
  );

describe('readBounded', () => {
  it('reads a body within the ceiling in order', async () => {
    const out = await readBounded(streamOf([new Uint8Array([1, 2]), new Uint8Array([3])]), 10);
    expect([...out]).toEqual([1, 2, 3]);
  });

  it('stops streaming once the ceiling is passed', async () => {
    let pulled = 0;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          pulled++;
          controller.enqueue(new Uint8Array(100));
          if (pulled > 1000) controller.close();
        },
      }),
    );
    await expect(readBounded(response, 250)).rejects.toMatchObject({ kind: 'too-large' });
    expect(pulled).toBeLessThan(20);
  });

  it('refuses on a declared length over the ceiling without reading', async () => {
    const response = streamOf([new Uint8Array(1)], { 'content-length': '999' });
    await expect(readBounded(response, 10)).rejects.toMatchObject({ kind: 'too-large' });
  });
});

describe('createPublicBytesFetcher', () => {
  it('fetches without credentials, referrer or cookies', async () => {
    const fetchMock = vi.fn(async () => new Response(new Uint8Array([9])));
    const bytes = await createPublicBytesFetcher({ fetch: fetchMock as unknown as typeof fetch })('https://cdn.example/a.png', { maxBytes: 5 });
    expect([...bytes]).toEqual([9]);
    expect(fetchMock).toHaveBeenCalledWith('https://cdn.example/a.png', expect.objectContaining({ credentials: 'omit', referrerPolicy: 'no-referrer' }));
  });

  it('treats a download that outlasts its timeout as a server failure, and a caller abort as neither', async () => {
    const hang = ((_url: string, init: RequestInit) => new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new DOMException('x', 'AbortError'))))) as unknown as typeof fetch;
    const fetcher = createPublicBytesFetcher({ fetch: hang });
    await expect(fetcher('https://cdn.example/a', { maxBytes: 5, timeoutMs: 10 })).rejects.toMatchObject({ kind: 'unavailable' });
    const controller = new AbortController();
    const pending = fetcher('https://cdn.example/a', { maxBytes: 5, timeoutMs: 60_000, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: 'network' });
  });

  it('turns network failures, bad statuses and unsafe addresses into closed kinds', async () => {
    const failing = createPublicBytesFetcher({ fetch: (async () => { throw new TypeError('secret detail'); }) as typeof fetch });
    await expect(failing('https://cdn.example/a', { maxBytes: 5 })).rejects.toMatchObject({ kind: 'network' });
    const missing = createPublicBytesFetcher({ fetch: (async () => new Response('', { status: 404 })) as typeof fetch });
    await expect(missing('https://cdn.example/a', { maxBytes: 5 })).rejects.toMatchObject({ kind: 'gone' });
    const broken = createPublicBytesFetcher({ fetch: (async () => new Response('', { status: 503 })) as typeof fetch });
    await expect(broken('https://cdn.example/a', { maxBytes: 5 })).rejects.toMatchObject({ kind: 'unavailable' });
    const never = vi.fn();
    const plain = createPublicBytesFetcher({ fetch: never as unknown as typeof fetch });
    for (const url of ['http://cdn.example/a', 'https://u:p@cdn.example/a', 'file:///etc/passwd', 'nonsense']) {
      await expect(plain(url, { maxBytes: 5 })).rejects.toMatchObject({ kind: 'bad-url' });
    }
    expect(never).not.toHaveBeenCalled();
    expect(isPublicHttpsUrl('https://cdn.example/a')).toBe(true);
  });
});
