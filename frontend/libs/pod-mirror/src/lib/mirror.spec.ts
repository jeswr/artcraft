import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BytesError } from './bytes.js';
import { createMemoryMirrorJournal, type MirrorJournal } from './journal.js';
import { DEFAULT_MAX_BYTES, type OpenStore, PodMirror, type PodMirrorOptions, backoffDelay } from './mirror.js';
import {
  ACCOUNT,
  JOURNAL_ACCOUNT,
  HOSTED_TOKEN_PREFIX,
  fakeBytes,
  fakeEvents,
  fakeHosted,
  fakeNetwork,
  fakeSession,
  fakeStore,
  glb,
  ply,
  spz,
  hostedFile,
  hostedPrompt,
  mp4,
  openFake,
  png,
  wav,
} from './testing.js';
import type { HostedMediaFile } from './types.js';

const token = (n: number) => `${HOSTED_TOKEN_PREFIX}${n}`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-10T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

function setup(files: HostedMediaFile[] = [], overrides: Partial<PodMirrorOptions> = {}, journal: MirrorJournal = createMemoryMirrorJournal()) {
  const hosted = fakeHosted(files);
  const store = fakeStore();
  const bytes = fakeBytes(hosted);
  const session = fakeSession();
  const network = fakeNetwork();
  const events = fakeEvents();
  const open = openFake(store);
  const mirror = new PodMirror({
    account: ACCOUNT,
    journal,
    hosted,
    openStore: open,
    fetchPublicBytes: bytes.fetch,
    session,
    network,
    events,
    random: () => 0.5,
    ...overrides,
  });
  return { hosted, store, bytes, session, network, events, open, mirror, journal };
}

const settle = async (mirror: PodMirror) => {
  await vi.advanceTimersByTimeAsync(0);
  await mirror.idle();
  await vi.advanceTimersByTimeAsync(0);
  await mirror.idle();
};

describe('copying one item', () => {
  it('saves it with its description input, journals it and keeps the hosted token off the pod', async () => {
    const file = hostedFile(1, { maybe_prompt_token: 'p_1', maybe_title: 'Fox' });
    const t = setup([file]);
    t.hosted.prompts.set('p_1', hostedPrompt('p_1'));
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);

    expect(t.mirror.stateOf(file.token)).toMatchObject({ kind: 'saved', thumbnail: 'attached' });
    expect(t.store.puts).toHaveLength(1);
    const put = t.store.puts[0] as { contentType: string; extension: string; createdAt: Date; description: { generation?: { prompt?: string } } };
    expect(put).toMatchObject({ contentType: 'image/png', extension: '.png', createdAt: new Date(file.created_at) });
    expect(put.description.generation?.prompt).toBe('a red fox at sunset');
    const record = await t.journal.get(JOURNAL_ACCOUNT, file.token);
    expect(record).toMatchObject({ state: 'saved', descriptionUrl: expect.stringContaining('https://pod.example/') });
    for (const seen of t.store.seen) {
      expect(seen).not.toContain(HOSTED_TOKEN_PREFIX);
      expect(seen).not.toContain('p_1');
      expect(seen).not.toContain('cdn.example');
    }
  });

  it('is idempotent: enqueueing a saved item again does nothing', async () => {
    const file = hostedFile(1);
    const t = setup([file]);
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    expect(t.store.puts).toHaveLength(1);
  });

  it('treats a verified already-exists as saved', async () => {
    const t = setup([hostedFile(1)]);
    t.store.existed = true;
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
  });

  it('classifies a video by its bytes and sends the duration', async () => {
    const file = hostedFile(2, { media_type: 'video', media_class: 'video', maybe_duration_millis: 4000, media_links: { cdn_url: 'https://cdn.example/v.mp4', thumbnail_template: '' } });
    const t = setup([file]);
    t.bytes.bodies.set('https://cdn.example/v.mp4', mp4());
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    const put = t.store.puts[0] as { contentType: string; description: { kind: string; duration: string } };
    expect(put.contentType).toBe('video/mp4');
    expect(put.description).toMatchObject({ kind: 'video', duration: 'PT4S' });
    expect(t.mirror.stateOf(file.token)).toMatchObject({ kind: 'saved', thumbnail: 'none' });
  });

  it('links a reference image only when it is already in the journal', async () => {
    const first = hostedFile(1);
    const second = hostedFile(2, { maybe_prompt_token: 'p_2' });
    const t = setup([first, second]);
    t.hosted.prompts.set('p_2', hostedPrompt('p_2', { maybe_context_images: [{ media_token: first.token, semantic: 'a' }, { media_token: 'm_unknown', semantic: 'b' }] }));
    await t.mirror.start();
    await t.mirror.enqueue(first.token);
    await settle(t.mirror);
    await t.mirror.enqueue(second.token);
    await settle(t.mirror);
    const used = (t.store.puts[1] as { description: { generation: { usedAssets: string[] } } }).description.generation.usedAssets;
    expect(used).toHaveLength(1);
    expect(used[0]).toMatch(/desc1#it$/);
  });
});

describe('what is not copied', () => {
  it('skips audio without downloading it, and says why', async () => {
    const file = hostedFile(1, { media_type: 'audio', media_class: 'audio' });
    const t = setup([file]);
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    expect(t.mirror.stateOf(file.token)).toEqual({ kind: 'skipped', reason: 'audio-unsupported' });
    expect(t.bytes.urls).toEqual([]);
    expect(t.store.puts).toEqual([]);
  });

  it('skips audio bytes hidden behind an image record', async () => {
    const file = hostedFile(1);
    const t = setup([file]);
    t.bytes.bodies.set(file.media_links.cdn_url, wav());
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    expect(t.mirror.stateOf(file.token)).toEqual({ kind: 'skipped', reason: 'audio-unsupported' });
  });

  it('skips scenes, intermediates and unsniffable bytes', async () => {
    const files = [hostedFile(1, { media_type: 'scene_json' }), hostedFile(2), hostedFile(3)];
    const t = setup(files, { isIntermediate: (f) => f.token === token(2) });
    t.bytes.bodies.set(files[2].media_links.cdn_url, new Uint8Array([1, 2, 3, 4]));
    await t.mirror.start();
    for (const f of files) await t.mirror.enqueue(f.token);
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'skipped', reason: 'scene' });
    expect(t.mirror.stateOf(token(2))).toEqual({ kind: 'skipped', reason: 'intermediate' });
    expect(t.mirror.stateOf(token(3))).toEqual({ kind: 'skipped', reason: 'unsupported-type' });
    expect(t.store.puts).toEqual([]);
  });

  it('skips an item the hosted side has already deleted', async () => {
    const t = setup([]);
    await t.mirror.start();
    await t.mirror.enqueue('m_gone');
    await settle(t.mirror);
    expect(t.mirror.stateOf('m_gone')).toEqual({ kind: 'skipped', reason: 'hosted-deleted' });
  });

  it('ignores a hostile token and never queues it', async () => {
    const t = setup([]);
    await t.mirror.start();
    for (const bad of ['', '../x', 'a b', 'x'.repeat(500), 'm_1?token=1']) await t.mirror.enqueue(bad);
    await settle(t.mirror);
    expect(t.hosted.calls.filter((c) => !c.startsWith('list:'))).toEqual([]);
    expect(t.mirror.summary().counts).toEqual({ saved: 0, pending: 0, failed: 0, skipped: 0, removing: 0 });
  });
});

describe('failures at each point', () => {
  it('retries a hosted outage with growing delays, then saves', async () => {
    const file = hostedFile(1);
    const t = setup([file]);
    t.hosted.down.add(file.token);
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    expect(t.mirror.stateOf(file.token)).toEqual({ kind: 'pending', attempts: 1, lastError: 'hosted-unavailable' });
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(t.mirror);
    expect(t.mirror.stateOf(file.token)).toMatchObject({ kind: 'pending', attempts: 2 });
    const calls = t.hosted.calls.filter((c) => c.startsWith('file:')).length;
    await vi.advanceTimersByTimeAsync(4_000); // second delay is longer than the first
    expect(t.hosted.calls.filter((c) => c.startsWith('file:')).length).toBe(calls);
    t.hosted.down.clear();
    await vi.advanceTimersByTimeAsync(10_000);
    await settle(t.mirror);
    expect(t.mirror.stateOf(file.token)?.kind).toBe('saved');
  });

  it('backoff grows, is capped and is jittered', () => {
    const delays = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => backoffDelay(n, 1000, 60_000, () => 0.5));
    for (let i = 1; i < delays.length; i++) expect(delays[i]).toBeGreaterThanOrEqual(delays[i - 1]);
    expect(delays[1]).toBeGreaterThan(delays[0]);
    expect(delays[2]).toBeGreaterThan(delays[1]);
    expect(delays[delays.length - 1]).toBeLessThanOrEqual(60_000 * 1.2);
    expect(backoffDelay(3, 1000, 60_000, () => 0)).toBeLessThan(backoffDelay(3, 1000, 60_000, () => 1));
  });

  it('spaces the engine retries further apart each time, up to the ceiling', async () => {
    const t = setup([hostedFile(1)], { baseDelayMs: 1_000, maxDelayMs: 8_000 });
    t.hosted.down.add(token(1));
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    const attemptsAt: number[] = [];
    let last = 0;
    for (let elapsed = 0; elapsed < 40_000; elapsed += 250) {
      await settle(t.mirror);
      const now = t.hosted.calls.filter((c) => c === `file:${token(1)}`).length;
      if (now > last) attemptsAt.push(elapsed);
      last = now;
      await vi.advanceTimersByTimeAsync(250);
    }
    const gaps = attemptsAt.slice(1).map((at, i) => at - attemptsAt[i]);
    expect(gaps[1]).toBeGreaterThan(gaps[0]);
    expect(gaps[2]).toBeGreaterThan(gaps[1]);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(8_000 * 1.2 + 250);
  });

  it('too large to write is skipped, not failed, and never retried; a missing file fails for good', async () => {
    const big = hostedFile(1);
    const gone = hostedFile(2);
    const t = setup([big, gone]);
    t.bytes.bodies.set(big.media_links.cdn_url, new BytesError('too-large'));
    t.bytes.bodies.set(gone.media_links.cdn_url, new BytesError('gone'));
    await t.mirror.start();
    await t.mirror.enqueue(big.token);
    await t.mirror.enqueue(gone.token);
    await settle(t.mirror);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await settle(t.mirror);
    expect(t.mirror.stateOf(big.token)).toEqual({ kind: 'skipped', reason: 'too-large' });
    expect(t.mirror.stateOf(gone.token)).toEqual({ kind: 'failed', reason: 'bytes-unavailable', attempts: 1 });
    expect(t.bytes.urls.filter((u) => u === big.media_links.cdn_url)).toHaveLength(1);
  });

  it.each([
    ['conflict', { kind: 'conflict', reason: 'hash-mismatch' }, 'conflict'],
    ['unsupported', { kind: 'unsupported', reason: 'unsniffable' }, 'unsupported'],
    ['failed (input)', { kind: 'failed', reason: 'invalid-input' }, 'invalid-description'],
  ] as const)('a store %s that keeps coming is final after three tries, with no further downloads', async (_n, error, reason) => {
    const t = setup([hostedFile(1)]);
    for (let i = 0; i < 20; i++) t.store.putFailures.push({ ...error });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    for (let i = 0; i < 6; i++) {
      await settle(t.mirror);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'failed', reason, attempts: 3 });
    expect(t.store.puts).toHaveLength(3);
    expect(t.bytes.urls.filter((u) => u === hostedFile(1).media_links.cdn_url)).toHaveLength(3);
  });

  it('a deterministic store failure that changes kind is not counted as a repeat', async () => {
    const t = setup([hostedFile(1)]);
    t.store.putFailures.push({ kind: 'conflict', reason: 'hash-mismatch' }, { kind: 'failed', reason: 'invalid-input' }, { kind: 'conflict', reason: 'hash-mismatch' });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    for (let i = 0; i < 6; i++) {
      await settle(t.mirror);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
  });

  it('counts an attempt and schedules the next before any download, so a crash or failure cannot re-download at once', async () => {
    const file = hostedFile(1);
    const journal = createMemoryMirrorJournal();
    const base = fakeBytes(fakeHosted([file]));
    let seen: { attempts?: number; next?: number } = {};
    const t = setup([file], {
      fetchPublicBytes: async (url, options) => {
        const record = await journal.get(JOURNAL_ACCOUNT, token(1));
        if (url === file.media_links.cdn_url) seen = { attempts: record?.attempts, next: record?.nextAttemptAt };
        return base.fetch(url, options);
      },
    }, journal);
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(seen.attempts).toBe(1);
    expect(seen.next).toBeGreaterThan(Date.now());
  });

  it('a store that is too large for the pod is skipped with its own reason', async () => {
    const t = setup([hostedFile(1)]);
    t.store.putFailures.push({ kind: 'too-large', reason: 'bytes-too-large' });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'skipped', reason: 'too-large' });
  });

  it('a refusal that may be an expired session is tried again with a fresh store before it is final', async () => {
    const t = setup([hostedFile(1)]);
    t.store.putFailures.push({ kind: 'forbidden', reason: 'storage' });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toMatchObject({ kind: 'pending', attempts: 1, lastError: 'forbidden' });
    expect(t.open.calls).toBe(2); // the store was opened again
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
  });

  it('a refusal that keeps coming is final after a few attempts', async () => {
    const t = setup([hostedFile(1)]);
    for (let i = 0; i < 10; i++) t.store.putFailures.push({ kind: 'forbidden', reason: 'storage' });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    for (let i = 0; i < 6; i++) {
      await settle(t.mirror);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'failed', reason: 'forbidden', attempts: 3 });
  });

  it('retries a store outage and an unexpected store error with backoff', async () => {
    const t = setup([hostedFile(1)]);
    t.store.putFailures.push({ kind: 'offline', reason: 'storage' }, { kind: 'failed', reason: 'unexpected' });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'pending', attempts: 1, lastError: 'offline' });
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(t.mirror);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
    expect(t.store.puts).toHaveLength(3);
  });

  it('an outage never ends an item: hours of failures later it is still pending, and it saves when the pod is back', async () => {
    const files = [hostedFile(1), hostedFile(2), hostedFile(3)];
    const t = setup(files);
    for (let i = 0; i < 1000; i++) t.store.putFailures.push({ kind: 'offline', reason: 'storage' });
    await t.mirror.start();
    for (const f of files) await t.mirror.enqueue(f.token);
    for (let i = 0; i < 12; i++) {
      await settle(t.mirror);
      await vi.advanceTimersByTimeAsync(15 * 60_000);
    }
    expect(t.mirror.summary().counts).toMatchObject({ failed: 0, pending: 3 });
    t.store.putFailures.length = 0;
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await settle(t.mirror);
    expect(t.mirror.summary().counts).toMatchObject({ saved: 3, failed: 0 });
  });

  it('waits at most about fifteen minutes between attempts, however long the outage', async () => {
    const t = setup([hostedFile(1)]);
    for (let i = 0; i < 1000; i++) t.store.putFailures.push({ kind: 'offline', reason: 'storage' });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    for (let i = 0; i < 14; i++) {
      await settle(t.mirror);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    const before = t.store.puts.length;
    await vi.advanceTimersByTimeAsync(19 * 60_000);
    await settle(t.mirror);
    expect(t.store.puts.length).toBeGreaterThan(before);
  });

  it('re-queues a retrying item at once when the app restarts, but waits out the backoff of one that keeps failing', async () => {
    const t = setup([hostedFile(1), hostedFile(2)]);
    t.store.putFailures.push({ kind: 'offline', reason: 'storage' });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toMatchObject({ kind: 'pending', attempts: 1 });
    await t.mirror.stop();
    const again = setup([hostedFile(1), hostedFile(2)], {}, t.journal);
    await again.mirror.start();
    await settle(again.mirror);
    expect(again.mirror.stateOf(token(1))?.kind).toBe('saved');

    // Five failed attempts in a row: a restart does not start another download at once.
    const worn = setup([hostedFile(2)]);
    for (let i = 0; i < 1000; i++) worn.store.putFailures.push({ kind: 'offline', reason: 'storage' });
    await worn.mirror.start();
    await worn.mirror.enqueue(token(2));
    for (let i = 0; i < 6; i++) {
      await settle(worn.mirror);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    }
    expect((await worn.journal.get(JOURNAL_ACCOUNT, token(2)))?.attempts).toBeGreaterThanOrEqual(3);
    await worn.mirror.stop();
    const downloads = worn.bytes.urls.length;
    const restarted = setup([hostedFile(2)], {}, worn.journal);
    await restarted.mirror.start();
    await settle(restarted.mirror);
    expect(restarted.store.puts).toHaveLength(0);
    expect(downloads).toBeGreaterThan(0);
  });

  it('a short connectivity blip never fails an item for good: every queued item saves when downloads work again', async () => {
    const files = [1, 2, 3, 4].map((n) => hostedFile(n));
    const t = setup(files);
    const urls = files.map((f) => f.media_links.cdn_url);
    const real = urls.map((u) => t.bytes.bodies.get(u)!);
    urls.forEach((u) => t.bytes.bodies.set(u, new BytesError('network')));
    await t.mirror.start();
    for (const f of files) await t.mirror.enqueue(f.token);
    for (let i = 0; i < 6; i++) {
      await settle(t.mirror);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(t.mirror.summary().counts).toMatchObject({ failed: 0, pending: 4 });
    urls.forEach((u, i) => t.bytes.bodies.set(u, real[i]));
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await settle(t.mirror);
    expect(t.mirror.summary().counts).toMatchObject({ saved: 4, failed: 0 });
    expect(t.mirror.summary().mediaHostBlocked).toBe(false);
  });

  it('says once that the media host cannot be reached when no download has ever worked, and stops saying it when one does', async () => {
    const files = [1, 2, 3, 4, 5, 6, 7].map((n) => hostedFile(n));
    const t = setup(files);
    const real = new Map(files.map((f) => [f.media_links.cdn_url, t.bytes.bodies.get(f.media_links.cdn_url)!]));
    for (const url of real.keys()) t.bytes.bodies.set(url, new BytesError('network'));
    await t.mirror.start();
    await settle(t.mirror);
    for (const f of files) await t.mirror.enqueue(f.token);
    for (let i = 0; i < 4; i++) {
      await settle(t.mirror);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(t.mirror.summary().mediaHostBlocked).toBe(true);
    expect(t.mirror.summary().counts.failed).toBe(0);
    for (const [url, body] of real) t.bytes.bodies.set(url, body);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await settle(t.mirror);
    expect(t.mirror.summary().mediaHostBlocked).toBe(false);
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.bytesEverOk).toBe(true);
  });

  it('does not call the media host unreachable when downloads worked before, or while the pod itself is paused', async () => {
    const files = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => hostedFile(n));
    const t = setup(files);
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    for (const f of files.slice(1)) t.bytes.bodies.set(f.media_links.cdn_url, new BytesError('network'));
    for (const f of files.slice(1)) await t.mirror.enqueue(f.token);
    for (let i = 0; i < 4; i++) {
      await settle(t.mirror);
      await vi.advanceTimersByTimeAsync(10_000);
    }
    expect(t.mirror.summary().mediaHostBlocked).toBe(false);
  });

  it('retry() puts a failed item back at the front with its attempts reset', async () => {
    const t = setup([hostedFile(1)]);
    for (let i = 0; i < 3; i++) t.store.putFailures.push({ kind: 'conflict', reason: 'hash-mismatch' });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    for (let i = 0; i < 4; i++) {
      await settle(t.mirror);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(t.mirror.stateOf(token(1))).toMatchObject({ kind: 'failed', attempts: 3 });
    await t.mirror.retry(token(1));
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'pending', attempts: 0 });
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
  });

  it('retryAllFailed puts every failed item back and leaves the others alone', async () => {
    const t = setup([hostedFile(1), hostedFile(2), hostedFile(3)]);
    let failing = true;
    const original = t.store.put.bind(t.store);
    t.store.put = async (input) =>
      failing && input.createdAt.getUTCMinutes() <= 2 ? { ok: false, error: { kind: 'conflict', reason: 'hash-mismatch' } } : original(input);
    await t.mirror.start();
    for (const n of [1, 2, 3]) await t.mirror.enqueue(token(n));
    for (let i = 0; i < 6; i++) {
      await settle(t.mirror);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(t.mirror.summary().counts).toMatchObject({ failed: 2, saved: 1 });
    failing = false;
    expect(await t.mirror.retryAllFailed()).toBe(2);
    await settle(t.mirror);
    expect(t.mirror.summary().counts).toMatchObject({ failed: 0, saved: 3 });
    expect(await t.mirror.retryAllFailed()).toBe(0);
  });

  it('retries an unknown token as a no-op', async () => {
    const t = setup();
    await t.mirror.start();
    await t.mirror.retry('m_nothing');
    expect(t.mirror.summary().counts.failed).toBe(0);
  });
});

describe('thumbnails', () => {
  it('goes ahead without one, then backfills it when the hosted thumbnail appears', async () => {
    const file = hostedFile(1);
    const t = setup([file], { thumbnailDelaysMs: [1_000, 2_000, 3_000] });
    t.store.linkThumbnail = false;
    const thumbUrl = 'https://cdn.example/thumbs/1/512.png';
    t.bytes.bodies.delete(thumbUrl);
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    expect(t.mirror.stateOf(file.token)).toMatchObject({ kind: 'saved', thumbnail: 'waiting' });
    t.bytes.bodies.set(thumbUrl, png(9));
    await vi.advanceTimersByTimeAsync(1_500);
    await settle(t.mirror);
    expect(t.mirror.stateOf(file.token)).toMatchObject({ kind: 'saved', thumbnail: 'attached' });
    expect(t.store.attached).toHaveLength(1);
  });

  it('gives up after a bounded number of tries without failing the item', async () => {
    const file = hostedFile(1);
    const t = setup([file], { thumbnailDelaysMs: [100, 100, 100] });
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    expect(t.mirror.stateOf(file.token)).toMatchObject({ thumbnail: 'attached' });

    const other = hostedFile(2);
    t.hosted.files.set(other.token, other);
    t.bytes.bodies.set(other.media_links.cdn_url, png(2));
    t.bytes.bodies.delete('https://cdn.example/thumbs/2/512.png');
    await t.mirror.enqueue(other.token);
    await settle(t.mirror);
    const before = t.bytes.urls.length;
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(500);
      await settle(t.mirror);
    }
    expect(t.mirror.stateOf(other.token)).toMatchObject({ kind: 'saved', thumbnail: 'none' });
    expect(t.bytes.urls.length - before).toBeLessThanOrEqual(3);
  });

  it('attaches a thumbnail the store did not link when it created the description', async () => {
    const file = hostedFile(1);
    const t = setup([file]);
    t.store.linkThumbnail = false;
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    expect(t.store.attached).toHaveLength(1);
    expect(t.mirror.stateOf(file.token)).toMatchObject({ thumbnail: 'attached' });
  });
});

describe('pausing and resuming', () => {
  it('does nothing while offline and finishes when the network returns, without spending attempts', async () => {
    const t = setup([hostedFile(1)]);
    await t.mirror.start();
    await settle(t.mirror);
    t.network.set(false);
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.hosted.calls.filter((c) => c.startsWith('file:'))).toEqual([]);
    expect(t.mirror.summary().paused).toBe('offline');
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'pending', attempts: 0 });
    t.network.set(true);
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
  });

  it('aborts in-flight work when the network drops and does not count it as a failure', async () => {
    const t = setup([hostedFile(1)]);
    let release: () => void = () => undefined;
    t.store.gate = new Promise((resolve) => (release = resolve));
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await vi.advanceTimersByTimeAsync(0);
    t.network.set(false);
    t.store.putFailures.push({ kind: 'failed', reason: 'aborted' });
    release();
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'pending', attempts: 0 });
  });

  it('pauses when the session is not connected and reopens the store on reconnect', async () => {
    const t = setup([hostedFile(1)]);
    await t.mirror.start();
    await settle(t.mirror);
    expect(t.open.calls).toBe(1);
    t.session.set(false);
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.mirror.summary().paused).toBe('session');
    expect(t.store.puts).toEqual([]);
    t.session.set(true);
    await settle(t.mirror);
    expect(t.open.calls).toBe(2);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
  });

  it('retries opening the store with backoff', async () => {
    const t = setup([hostedFile(1)]);
    t.open.fail = 'offline';
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.mirror.summary().paused).toBe('store-unavailable');
    t.open.fail = null;
    await vi.advanceTimersByTimeAsync(10_000);
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
  });

  it('copies at most `concurrency` items at once', async () => {
    const files = [1, 2, 3, 4, 5].map((n) => hostedFile(n));
    const t = setup(files, { concurrency: 2 });
    let active = 0;
    let peak = 0;
    const original = t.store.put.bind(t.store);
    t.store.put = async (input) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 100));
      const result = await original(input);
      active--;
      return result;
    };
    await t.mirror.start();
    for (const f of files) await t.mirror.enqueue(f.token);
    await vi.advanceTimersByTimeAsync(1_000);
    await settle(t.mirror);
    expect(peak).toBe(2);
    expect(t.mirror.summary().counts.saved).toBe(5);
  });
});

describe('exposure', () => {
  it('refuses to write while the library is readable by others, and says so', async () => {
    const t = setup([hostedFile(1)]);
    t.store.exposure = 'exposed';
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.store.puts).toEqual([]);
    expect(t.mirror.summary().paused).toBe('exposed');
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'pending', attempts: 0 });
  });

  it('fails closed on an inconclusive answer', async () => {
    const t = setup([hostedFile(1)]);
    t.store.exposure = 'unknown';
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.store.puts).toEqual([]);
    expect(t.mirror.summary().paused).toBe('exposure-unknown');
  });

  it('resumes after the person fixes it and presses retry', async () => {
    const t = setup([hostedFile(1)]);
    t.store.exposure = 'exposed';
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    t.store.exposure = 'private';
    await t.mirror.retry(token(1));
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
    expect(t.mirror.summary().paused).toBeNull();
  });

  it('holds the item that met an exposure refusal at write time, uncounted, and the rest behind it', async () => {
    const t = setup([hostedFile(1), hostedFile(2)], { concurrency: 1 });
    t.store.putFailures.push({ kind: 'exposed', reason: 'library-exposed' });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await t.mirror.enqueue(token(2));
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'pending', attempts: 0 });
    expect(t.mirror.stateOf(token(2))?.kind).toBe('pending');
    expect(t.mirror.summary().paused).toBe('exposed');
    expect(t.store.puts).toHaveLength(1);
  });

  it('never writes before the check has said private', async () => {
    const t = setup([hostedFile(1)]);
    t.store.exposure = 'offline';
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.store.puts).toEqual([]);
  });
});

describe('reconcile', () => {
  const library = (count: number) => Array.from({ length: count }, (_, i) => hostedFile(i + 1));
  const empty = (t: ReturnType<typeof setup>) => t.journal.ensureBaseline(JOURNAL_ACCOUNT, { kind: 'empty' });
  const add = (t: ReturnType<typeof setup>, file: HostedMediaFile) => {
    t.hosted.files.set(file.token, file);
    t.hosted.listing.unshift(file);
    const n = Number(file.token.replace(HOSTED_TOKEN_PREFIX, ''));
    t.bytes.bodies.set(file.media_links.cdn_url, png(n));
    t.bytes.bodies.set(`https://cdn.example/thumbs/${n}/512.png`, png(n + 100));
  };

  it('takes its baseline from the newest hosted item, not from the local clock', async () => {
    const files = library(3);
    const t = setup(files);
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z')); // a local clock far ahead of the server
    await t.mirror.start();
    await settle(t.mirror);
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.baseline).toEqual({ kind: 'item', token: token(3), createdAt: new Date(files[2].created_at).getTime() });
    expect(t.mirror.summary().counts).toMatchObject({ saved: 0, pending: 0 });
    // Something uploaded after connecting has a server time after the baseline, whatever the clock says.
    add(t, hostedFile(9, { created_at: '2026-06-02T00:00:00.000Z' }));
    await t.mirror.reconcile();
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(9))?.kind).toBe('saved');
    expect(t.mirror.stateOf(token(2))).toBeUndefined();
  });

  it('records an empty library as empty, and then copies everything that appears', async () => {
    const t = setup([]);
    await t.mirror.start();
    await settle(t.mirror);
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.baseline).toEqual({ kind: 'empty' });
    add(t, hostedFile(1));
    await t.mirror.reconcile();
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
  });

  it('waits for the baseline while the hosted listing is down and copies nothing old', async () => {
    const t = setup(library(2));
    t.hosted.listDown = true;
    await t.mirror.start();
    await settle(t.mirror);
    expect((await t.mirror.reconcile()).stoppedBy).toBe('hosted-unavailable');
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.baseline).toBeUndefined();
    t.hosted.listDown = false;
    await t.mirror.reconcile();
    await settle(t.mirror);
    expect(t.mirror.summary().counts.saved).toBe(0);
  });

  it('stops at the baseline item and not before', async () => {
    const files = library(6);
    const t = setup(files.slice(0, 3), { pageSize: 2 }); // connect with items 1..3 listed
    await t.mirror.start();
    await settle(t.mirror);
    for (const n of [4, 5, 6]) add(t, files[n - 1]);
    await t.mirror.reconcile();
    await settle(t.mirror);
    for (const n of [4, 5, 6]) expect(t.mirror.stateOf(token(n))?.kind).toBe('saved');
    for (const n of [1, 2, 3]) expect(t.mirror.stateOf(token(n))).toBeUndefined();
  });

  it('does not stop at a journalled item: an upload behind a typed event is still copied', async () => {
    const t = setup([hostedFile(1)]);
    await t.mirror.start();
    await settle(t.mirror);
    add(t, hostedFile(2)); // an upload: no event
    add(t, hostedFile(3)); // a generation: its event journals it directly
    t.events.emit({ type: 'added', tokens: [token(3)] });
    await settle(t.mirror);
    const result = await t.mirror.reconcile();
    await settle(t.mirror);
    expect(result.enqueued).toBe(1);
    expect(t.mirror.stateOf(token(2))?.kind).toBe('saved');
    expect(t.mirror.stateOf(token(3))?.kind).toBe('saved');
  });

  it('stops at the last completed walk and saves its place when it is interrupted', async () => {
    const t = setup([hostedFile(1)], { pageSize: 2 });
    await t.mirror.start();
    await settle(t.mirror);
    for (const n of [2, 3, 4, 5, 6]) add(t, hostedFile(n));
    const list = t.hosted.listUserMediaFiles.bind(t.hosted);
    let fail = true;
    t.hosted.listUserMediaFiles = async (page, size, signal) => (page >= 1 && fail ? { ok: false, kind: 'unavailable' } : list(page, size, signal));
    const first = await t.mirror.reconcile();
    expect(first).toMatchObject({ stoppedBy: 'hosted-unavailable', enqueued: 2 });
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.mark).toMatchObject({ token: token(1) }); // still the last completed walk's
    fail = false;
    const second = await t.mirror.reconcile();
    await settle(t.mirror);
    expect(second.stoppedBy).toBe('mark');
    for (const n of [2, 3, 4, 5, 6]) expect(t.mirror.stateOf(token(n))?.kind).toBe('saved');
    const done = await t.journal.getAccountState(JOURNAL_ACCOUNT);
    expect(done?.mark).toMatchObject({ token: token(6) });
    // The next walk stops at the mark at once.
    const calls = t.hosted.calls.length;
    expect((await t.mirror.reconcile()).stoppedBy).toBe('mark');
    expect(t.hosted.calls.slice(calls)).toEqual(['list:0']);
  });

  it('starts again from the newest item after an interrupted walk, so bulk deletions cannot hide unseen items', async () => {
    const t = setup([hostedFile(1)], { pageSize: 2 });
    await t.mirror.start();
    await settle(t.mirror);
    for (const n of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) add(t, hostedFile(n));
    const list = t.hosted.listUserMediaFiles.bind(t.hosted);
    let failFrom = 3;
    t.hosted.listUserMediaFiles = async (page, size, signal) => (page >= failFrom ? { ok: false, kind: 'unavailable' } : list(page, size, signal));
    await t.mirror.reconcile();
    await settle(t.mirror);
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.mark).toMatchObject({ token: token(1) }); // not moved by a walk that did not finish
    // Four of the newest are deleted on the hosted side meanwhile: the unseen ones slide up.
    for (const n of [11, 10, 9, 8]) {
      t.hosted.files.delete(token(n));
      t.hosted.listing = t.hosted.listing.filter((f) => f.token !== token(n));
    }
    failFrom = 99;
    const before = t.hosted.calls.length;
    await t.mirror.reconcile();
    await settle(t.mirror);
    expect(t.hosted.calls.slice(before).filter((c) => c.startsWith('list:'))[0]).toBe('list:0');
    for (const n of [2, 3, 4, 5, 6, 7]) expect(t.mirror.stateOf(token(n))?.kind).toBe('saved');
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.mark).toMatchObject({ token: token(7) });
  });

  it('measures "older than the last walk" against the newer of the mark and the baseline, strictly', async () => {
    const files = [1, 2, 3, 4, 5, 6].map((n) => hostedFile(n));
    const t = setup(files);
    await t.mirror.start();
    await settle(t.mirror);
    // Walk once so the mark sits at item 6, then lose the mark's item on the hosted side.
    add(t, hostedFile(7));
    await t.mirror.reconcile();
    await settle(t.mirror);
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.mark).toMatchObject({ token: token(7) });
    t.hosted.files.delete(token(7));
    t.hosted.listing = t.hosted.listing.filter((f) => f.token !== token(7));
    // One item dated before the mark but after the baseline (an old upload dated back): the walk
    // treats it as older than where it already got to. One dated exactly at the mark is not older.
    const backdated = hostedFile(100, { created_at: hostedFile(4).created_at });
    const sameTime = hostedFile(101, { created_at: hostedFile(7).created_at });
    const newer = hostedFile(102, { created_at: new Date(Date.UTC(2026, 5, 2)).toISOString() });
    // Dated after the baseline (item 6) but before the mark (item 7): older than the walk has been.
    const midpoint = (new Date(hostedFile(6).created_at).getTime() + new Date(hostedFile(7).created_at).getTime()) / 2;
    const between = hostedFile(103, { created_at: new Date(midpoint).toISOString() });
    for (const f of [backdated, sameTime, newer, between]) {
      t.hosted.files.set(f.token, f);
      t.bytes.bodies.set(f.media_links.cdn_url, png(1));
      t.bytes.bodies.set(`https://cdn.example/thumbs/${f.token}/512.png`, png(2));
    }
    t.hosted.listing = [newer, sameTime, ...t.hosted.listing.filter((f) => f.token !== newer.token), between, backdated].sort((a, b) => b.created_at.localeCompare(a.created_at));
    await t.mirror.reconcile();
    await settle(t.mirror);
    expect(t.mirror.stateOf(newer.token)?.kind).toBe('saved');
    expect(t.mirror.stateOf(sameTime.token)?.kind).toBe('saved');
    expect(t.mirror.stateOf(backdated.token)).toBeUndefined();
    expect(t.mirror.stateOf(between.token)).toBeUndefined();
  });

  it('does not stop at an old item when the listing is not newest first, and still takes the new ones after it', async () => {
    const t = setup([hostedFile(5)], { pageSize: 10 });
    await t.mirror.start();
    await settle(t.mirror);
    const fresh = [hostedFile(11), hostedFile(12)];
    const old = hostedFile(2);
    for (const f of [...fresh, old]) {
      t.hosted.files.set(f.token, f);
      t.bytes.bodies.set(f.media_links.cdn_url, png(1));
    }
    t.hosted.listing = [fresh[0], old, fresh[1], hostedFile(5)];
    const result = await t.mirror.reconcile();
    await settle(t.mirror);
    expect(result.orderUnverified).toBe(true);
    expect(t.mirror.stateOf(fresh[0].token)?.kind).toBe('saved');
    expect(t.mirror.stateOf(fresh[1].token)?.kind).toBe('saved');
    expect(t.mirror.stateOf(old.token)).toBeUndefined();
  });

  it('walks more than one page when many items arrived since the last run', async () => {
    const t = setup([], { pageSize: 3 });
    await t.mirror.start();
    await settle(t.mirror);
    for (const file of library(7)) add(t, file);
    const result = await t.mirror.reconcile();
    await settle(t.mirror);
    expect(result.pages).toBe(3);
    expect(t.mirror.summary().counts.saved).toBe(7);
  });

  it('does not stop early when the hosted listing is not newest first', async () => {
    const files = library(4);
    const t = setup(files, { pageSize: 10 });
    t.hosted.listing = [files[1], files[3], files[0], files[2]];
    await empty(t);
    await t.mirror.start();
    await settle(t.mirror);
    const result = await t.mirror.reconcile();
    await settle(t.mirror);
    expect(result.orderUnverified).toBe(true);
    for (const n of [1, 2, 3, 4]) expect(t.mirror.stateOf(token(n))?.kind).toBe('saved');
  });

  it('shows an item whose date cannot be read as skipped, instead of copying or losing it, and retries it', async () => {
    const t = setup([hostedFile(1)]);
    await t.mirror.start();
    await settle(t.mirror);
    add(t, hostedFile(2, { created_at: 'last tuesday' }));
    await t.mirror.reconcile();
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(2))).toEqual({ kind: 'skipped', reason: 'bad-date' });
    expect(t.store.puts).toHaveLength(0);
    await t.mirror.retryAllFailed();
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(2))?.kind).toBe('saved');
  });

  it('reports a hosted outage and tries again on the next call', async () => {
    const t = setup([]);
    await empty(t);
    await t.mirror.start();
    await settle(t.mirror);
    add(t, hostedFile(1));
    add(t, hostedFile(2));
    t.hosted.listDown = true;
    expect((await t.mirror.reconcile()).stoppedBy).toBe('hosted-unavailable');
    t.hosted.listDown = false;
    const result = await t.mirror.reconcile();
    await settle(t.mirror);
    expect(result.enqueued).toBe(2);
  });

  it('journals what it skips so the gallery can say why', async () => {
    const files = [hostedFile(1), hostedFile(2, { media_type: 'mp3', media_class: 'audio' })];
    const t = setup(files);
    await empty(t);
    await t.mirror.start();
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(2))).toEqual({ kind: 'skipped', reason: 'audio-unsupported' });
  });

  it('is not run when stopped', async () => {
    const t = setup(library(1));
    expect((await t.mirror.reconcile()).stoppedBy).toBe('not-running');
  });
});

describe('events', () => {
  it('copies items the app reports and walks the listing once for a burst of changes', async () => {
    const files = [hostedFile(1), hostedFile(2), hostedFile(3)];
    const t = setup(files);
    await t.journal.ensureBaseline(JOURNAL_ACCOUNT, { kind: 'empty' });
    t.hosted.listing = [];
    await t.mirror.start();
    await settle(t.mirror);
    t.events.emit({ type: 'added', tokens: [token(1), token(2)] });
    await settle(t.mirror);
    expect(t.mirror.summary().counts.saved).toBe(2);
    t.hosted.listing = [files[2]];
    const listsBefore = t.hosted.calls.filter((c) => c.startsWith('list:')).length;
    for (let i = 0; i < 4; i++) t.events.emit({ type: 'changed' });
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(t.mirror);
    expect(t.hosted.calls.filter((c) => c.startsWith('list:')).length - listsBefore).toBe(1);
    expect(t.mirror.stateOf(token(3))?.kind).toBe('saved');
  });

  it('unsubscribes everything on stop', async () => {
    const t = setup();
    await t.mirror.start();
    expect(t.events.subscribers).toBe(1);
    await t.mirror.stop();
    expect(t.events.subscribers).toBe(0);
  });
});

describe('delete pairing', () => {
  const saved = async (t: ReturnType<typeof setup>, n = 1) => {
    await t.mirror.enqueue(token(n));
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(n))?.kind).toBe('saved');
  };

  it('removes the pod copy when the hosted item is deleted', async () => {
    const t = setup([hostedFile(1)]);
    await t.mirror.start();
    await saved(t);
    const url = (t.mirror.stateOf(token(1)) as { descriptionUrl: string }).descriptionUrl;
    t.events.emit({ type: 'deleted', token: token(1) });
    await settle(t.mirror);
    expect(t.store.removed).toEqual([url]);
    expect(t.mirror.stateOf(token(1))).toBeUndefined();
    expect(await t.journal.get(JOURNAL_ACCOUNT, token(1))).toBeUndefined();
  });

  it('keeps a failed half visible, retries it, and finishes', async () => {
    const t = setup([hostedFile(1)]);
    await t.mirror.start();
    await saved(t);
    for (let i = 0; i < 3; i++) t.store.removeFailures.push({ kind: 'conflict', reason: 'hash-mismatch' });
    t.events.emit({ type: 'deleted', token: token(1) });
    for (let i = 0; i < 4; i++) {
      await settle(t.mirror);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'remove-failed', reason: 'conflict', attempts: 3 });
    expect(t.mirror.summary().counts.failed).toBe(1);
    await t.mirror.retry(token(1));
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toBeUndefined();
    expect(t.store.removed).toHaveLength(1);
  });

  it('resumes a removal that a crash interrupted', async () => {
    const journal = createMemoryMirrorJournal();
    await journal.ensureBaseline(JOURNAL_ACCOUNT, { kind: 'empty' });
    await journal.create({ ...JOURNAL_ACCOUNT, token: token(1), state: 'removing', attempts: 0, createdAt: 1, updatedAt: 1, descriptionUrl: 'https://pod.example/alice/creative-assets/2026/06/descX' });
    const t = setup([], {}, journal);
    await t.mirror.start();
    await settle(t.mirror);
    expect(t.store.removed).toEqual(['https://pod.example/alice/creative-assets/2026/06/descX']);
    expect(t.store.resumed).toBe(1);
    expect(await journal.get(JOURNAL_ACCOUNT, token(1))).toBeUndefined();
  });

  it('removes a copy that finishes after its hosted item was deleted', async () => {
    const t = setup([hostedFile(1)]);
    let release: () => void = () => undefined;
    t.store.gate = new Promise((resolve) => (release = resolve));
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await vi.advanceTimersByTimeAsync(0);
    t.events.emit({ type: 'deleted', token: token(1) });
    release();
    await settle(t.mirror);
    expect(t.store.removed).toHaveLength(1);
    expect(t.mirror.stateOf(token(1))).toBeUndefined();
  });

  it('drops an item that never reached the pod without touching the pod', async () => {
    const t = setup([hostedFile(1)]);
    t.store.putFailures.push({ kind: 'conflict', reason: 'hash-mismatch' });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    t.events.emit({ type: 'deleted', token: token(1) });
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toBeUndefined();
    expect(t.store.removed).toEqual([]);
  });

  it('ignores a delete for an item it never journalled', async () => {
    const t = setup();
    await t.mirror.start();
    t.events.emit({ type: 'deleted', token: 'm_unknown' });
    await settle(t.mirror);
    expect(t.store.removed).toEqual([]);
  });
});

describe('restart, accounts and forgetting', () => {
  it('resumes what was pending when the app closed', async () => {
    const journal = createMemoryMirrorJournal();
    await journal.ensureBaseline(JOURNAL_ACCOUNT, { kind: 'empty' });
    await journal.create({ ...ACCOUNT, token: token(1), state: 'pending', attempts: 2, createdAt: 1, updatedAt: 1 });
    const t = setup([hostedFile(1)], {}, journal);
    await t.mirror.start();
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
  });

  it('keeps two accounts apart, even for the same token', async () => {
    const journal = createMemoryMirrorJournal();
    const a = setup([hostedFile(1)], {}, journal);
    const b = setup([hostedFile(1)], { account: { webId: ACCOUNT.webId, username: 'other_user' } }, journal);
    await a.mirror.start();
    await b.mirror.start();
    await a.mirror.enqueue(token(1));
    await settle(a.mirror);
    expect(a.mirror.stateOf(token(1))?.kind).toBe('saved');
    expect(b.mirror.stateOf(token(1))).toBeUndefined();
    expect(await journal.get({ webId: ACCOUNT.webId, username: 'other_user' }, token(1))).toBeUndefined();
    await b.mirror.enqueue(token(1));
    await settle(b.mirror);
    expect(b.store.puts).toHaveLength(1);
    expect(a.store.puts).toHaveLength(1);
  });

  it('forgetAccount stops, purges and refuses to start again', async () => {
    const t = setup([hostedFile(1)]);
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    await t.mirror.forgetAccount();
    expect(await t.journal.list(JOURNAL_ACCOUNT)).toEqual([]);
    expect(t.mirror.summary().counts.saved).toBe(0);
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    expect(await t.journal.list(JOURNAL_ACCOUNT)).toEqual([]);
  });

  it('a stopped mirror keeps its journal and notifies subscribers of changes', async () => {
    const t = setup([hostedFile(1)]);
    const seen: number[] = [];
    t.mirror.subscribe(() => seen.push(t.mirror.summary().version));
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    await t.mirror.stop();
    expect(await t.journal.get(JOURNAL_ACCOUNT, token(1))).toMatchObject({ state: 'saved' });
    expect(new Set(seen).size).toBeGreaterThan(2);
    expect(t.mirror.summary().paused).toBe('stopped');
  });
});

describe('one pod copy for several hosted items', () => {
  const twins = async () => {
    const t = setup([hostedFile(1), hostedFile(2)]);
    t.store.fixedUrl = 'https://pod.example/alice/creative-assets/2026/06/shared';
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await t.mirror.enqueue(token(2));
    await settle(t.mirror);
    return t;
  };

  it('keeps the copy while another hosted item still points at it, and removes it with the last one', async () => {
    const t = await twins();
    expect(t.mirror.summary().counts.saved).toBe(2);
    t.events.emit({ type: 'deleted', token: token(1) });
    await settle(t.mirror);
    expect(t.store.removed).toEqual([]);
    // A delete the store had pending for the shared copy is withdrawn, not left for a later start.
    expect(t.store.withdrawn).toContain('https://pod.example/alice/creative-assets/2026/06/shared');
    expect(t.mirror.stateOf(token(1))).toBeUndefined();
    expect(t.mirror.stateOf(token(2))).toMatchObject({ kind: 'saved', descriptionUrl: 'https://pod.example/alice/creative-assets/2026/06/shared' });
    expect(await t.journal.get(JOURNAL_ACCOUNT, token(2))).toMatchObject({ state: 'saved' });
    t.events.emit({ type: 'deleted', token: token(2) });
    await settle(t.mirror);
    expect(t.store.removed).toEqual(['https://pod.example/alice/creative-assets/2026/06/shared']);
  });

  it('does not count a twin that is no longer a saved copy as a reason to keep the copy', async () => {
    const journal = createMemoryMirrorJournal();
    const url = 'https://pod.example/alice/creative-assets/2026/06/shared';
    await journal.ensureBaseline(JOURNAL_ACCOUNT, { kind: 'empty' });
    await journal.create({ ...JOURNAL_ACCOUNT, token: token(1), state: 'saved', attempts: 0, createdAt: 1, updatedAt: 1, descriptionUrl: url });
    await journal.create({ ...JOURNAL_ACCOUNT, token: token(2), state: 'remove-failed', attempts: 3, createdAt: 1, updatedAt: 1, descriptionUrl: url });
    const t = setup([], {}, journal);
    await t.mirror.start();
    await settle(t.mirror);
    t.store.removed.length = 0;
    t.events.emit({ type: 'deleted', token: token(1) });
    await settle(t.mirror);
    expect(t.store.removed).toEqual([url]);
  });

  it('counts every hosted account on this device: another account holding the same URL keeps the copy', async () => {
    const journal = createMemoryMirrorJournal();
    const url = 'https://pod.example/alice/creative-assets/2026/06/shared';
    await journal.create({ ...ACCOUNT, username: 'someone_else', token: token(9), state: 'saved', attempts: 0, createdAt: 1, updatedAt: 1, descriptionUrl: url });
    const t = setup([hostedFile(1)], {}, journal);
    t.store.fixedUrl = url;
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    t.events.emit({ type: 'deleted', token: token(1) });
    await settle(t.mirror);
    expect(t.store.removed).toEqual([]);
    expect(t.mirror.stateOf(token(1))).toBeUndefined();
    expect(await journal.get({ ...ACCOUNT, username: 'someone_else' }, token(9))).toMatchObject({ state: 'saved', descriptionUrl: url });
  });

  it('two hosted accounts on one pod holding the same bytes: the copy goes only with the last account to delete', async () => {
    const journal = createMemoryMirrorJournal();
    const url = 'https://pod.example/alice/creative-assets/2026/06/shared';
    const store = fakeStore();
    store.fixedUrl = url;
    const make = (username: string) => {
      const hosted = fakeHosted([hostedFile(1)]);
      hosted.user = username;
      const events = fakeEvents();
      const mirror = new PodMirror({
        account: { webId: ACCOUNT.webId, username },
        journal,
        hosted,
        openStore: openFake(store),
        fetchPublicBytes: fakeBytes(hosted).fetch,
        session: fakeSession(),
        network: fakeNetwork(),
        events,
        random: () => 0.5,
      });
      return { mirror, events };
    };
    const a = make('alice_hosted');
    const b = make('bob_hosted');
    for (const x of [a, b]) {
      await x.mirror.start();
      await x.mirror.enqueue(token(1));
      await settle(x.mirror);
      expect(x.mirror.stateOf(token(1))).toMatchObject({ kind: 'saved', descriptionUrl: url });
    }
    a.events.emit({ type: 'deleted', token: token(1) });
    await settle(a.mirror);
    expect(store.removed).toEqual([]);
    expect(a.mirror.stateOf(token(1))).toBeUndefined();
    // B's pairing is intact and its copy answers.
    expect(b.mirror.stateOf(token(1))).toMatchObject({ kind: 'saved', descriptionUrl: url });
    expect((await store.get(url)).ok).toBe(true);
    b.events.emit({ type: 'deleted', token: token(1) });
    await settle(b.mirror);
    expect(store.removed).toEqual([url]);
    expect(await journal.list({ webId: ACCOUNT.webId, username: 'bob_hosted|https://api.example' })).toEqual([]);
  });

  it('one account holding the same bytes under two tokens, found only in the journal after a restart, keeps the copy', async () => {
    const journal = createMemoryMirrorJournal();
    const url = 'https://pod.example/alice/creative-assets/2026/06/shared';
    await journal.ensureBaseline(JOURNAL_ACCOUNT, { kind: 'empty' });
    for (const n of [1, 2]) await journal.create({ ...JOURNAL_ACCOUNT, token: token(n), state: 'saved', attempts: 0, createdAt: 1, updatedAt: 1, descriptionUrl: url });
    const t = setup([], {}, journal);
    await t.mirror.start();
    await settle(t.mirror);
    t.events.emit({ type: 'deleted', token: token(1) });
    await settle(t.mirror);
    expect(t.store.removed).toEqual([]);
    expect(t.mirror.stateOf(token(2))).toMatchObject({ kind: 'saved' });
  });

  it('does not delete when the journal cannot say who else pairs with the copy', async () => {
    const t = setup([hostedFile(1)]);
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    vi.spyOn(t.journal, 'isPairedElsewhere').mockRejectedValue(new Error('journal down'));
    t.events.emit({ type: 'deleted', token: token(1) });
    await settle(t.mirror);
    expect(t.store.removed).toEqual([]);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('removing');
  });

  it('a delete that takes the shared copy while another item is writing it makes that write repeat, not leave a dead link', async () => {
    const t = setup([hostedFile(1), hostedFile(2)]);
    t.store.fixedUrl = 'https://pod.example/alice/creative-assets/2026/06/shared';
    const url = t.store.fixedUrl;
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    // Item 2 (the same bytes) is mid-put when item 1's delete runs; nothing pairs with the copy yet.
    let release: () => void = () => undefined;
    t.store.gate = new Promise<void>((resolve) => (release = resolve));
    await t.mirror.enqueue(token(2));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.store.puts).toHaveLength(2);
    t.store.gate = null;
    t.events.emit({ type: 'deleted', token: token(1) });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.store.removed).toEqual([url]);
    release();
    await settle(t.mirror);
    expect(t.store.puts).toHaveLength(3);
    expect(t.mirror.stateOf(token(2))).toMatchObject({ kind: 'saved', descriptionUrl: url });
    expect((await t.store.get(url)).ok).toBe(true);
  });
});

describe('items ArtCraft no longer lists', () => {
  const saved = async (count: number, overrides: Partial<PodMirrorOptions> = {}) => {
    const files = Array.from({ length: count }, (_, i) => hostedFile(i + 1));
    const t = setup(files, overrides);
    await t.mirror.start();
    for (const f of files) await t.mirror.enqueue(f.token);
    await settle(t.mirror);
    expect(t.mirror.summary().counts.saved).toBe(count);
    t.hosted.calls.length = 0;
    return t;
  };

  it('marks an item the hosted side says is gone and keeps its pod copy', async () => {
    const t = await saved(3);
    t.hosted.files.delete(token(2));
    expect(await t.mirror.verify(true)).toMatchObject({ checked: 3, flagged: 1, stoppedBy: 'done' });
    await settle(t.mirror);
    expect(t.mirror.summary().goneFromArtcraft).toBe(1);
    expect(t.mirror.summary().counts.saved).toBe(3);
    expect(t.store.removed).toEqual([]);
  });

  it('never deletes a library because every lookup says "not found" (another backend, a lost session)', async () => {
    const t = await saved(30);
    t.hosted.files.clear();
    expect(await t.mirror.verify(true)).toMatchObject({ checked: 30, flagged: 30 });
    await settle(t.mirror);
    await vi.advanceTimersByTimeAsync(3 * 24 * 3_600_000);
    await settle(t.mirror);
    expect(t.store.removed).toEqual([]);
    expect(t.mirror.summary().counts.saved).toBe(30);
  });

  it('only removes the marked copies after the person asks, and only those', async () => {
    const t = await saved(3);
    t.hosted.files.delete(token(2));
    await t.mirror.verify(true);
    expect(await t.mirror.removeGoneFromPod()).toBe(1);
    await settle(t.mirror);
    expect(t.store.removed).toHaveLength(1);
    expect(t.mirror.stateOf(token(2))).toBeUndefined();
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
    expect(t.mirror.stateOf(token(3))?.kind).toBe('saved');
    expect(t.mirror.summary().goneFromArtcraft).toBe(0);
  });

  it('refuses to remove on request while a different hosted user is signed in', async () => {
    const t = await saved(2);
    t.hosted.files.delete(token(1));
    await t.mirror.verify(true);
    t.hosted.user = 'someone_else';
    expect(await t.mirror.removeGoneFromPod()).toBe(0);
    await settle(t.mirror);
    expect(t.store.removed).toEqual([]);
  });

  it('clears the mark when the item is listed again', async () => {
    const t = await saved(2);
    const lost = t.hosted.files.get(token(1))!;
    t.hosted.files.delete(token(1));
    await t.mirror.verify(true);
    expect(t.mirror.summary().goneFromArtcraft).toBe(1);
    t.hosted.files.set(token(1), lost);
    await t.mirror.verify(true);
    expect(t.mirror.summary().goneFromArtcraft).toBe(0);
  });

  it('looks items up in chunks and confirms a missing one by itself before marking it', async () => {
    const t = await saved(5, { verifyChunk: 2 });
    t.hosted.files.delete(token(4));
    await t.mirror.verify(true);
    await settle(t.mirror);
    expect(t.hosted.calls.filter((c) => c.startsWith('batch:'))).toEqual(['batch:2', 'batch:2', 'batch:1']);
    expect(t.hosted.calls).toContain(`file:${token(4)}`);
    expect(t.mirror.summary().goneFromArtcraft).toBe(1);
  });

  it('keeps an item the batch omits when its own lookup still finds it', async () => {
    const t = await saved(2);
    const real = t.hosted.getMediaFiles.bind(t.hosted);
    t.hosted.getMediaFiles = async (tokens, signal) => {
      const got = await real(tokens, signal);
      return got.ok ? { ok: true, value: got.value.filter((f) => f.token !== token(1)) } : got;
    };
    expect(await t.mirror.verify(true)).toMatchObject({ flagged: 0, stoppedBy: 'done' });
    expect(t.mirror.summary().goneFromArtcraft).toBe(0);
  });

  it('marks nothing when the lookup fails, when the item cannot be confirmed, or when offline', async () => {
    const t = await saved(2);
    t.hosted.files.delete(token(1));
    t.hosted.batchDown = true;
    expect((await t.mirror.verify(true)).stoppedBy).toBe('hosted-unavailable');
    t.hosted.batchDown = false;
    t.hosted.down.add(token(1)); // the item's own lookup errors instead of answering "not found"
    expect((await t.mirror.verify(true)).stoppedBy).toBe('hosted-unavailable');
    t.hosted.down.clear();
    t.network.set(false);
    t.hosted.calls.length = 0;
    expect((await t.mirror.verify(true)).stoppedBy).toBe('hosted-unavailable');
    expect(t.hosted.calls).toEqual([]);
    expect(t.mirror.summary().goneFromArtcraft).toBe(0);
  });

  it('stops without marking when the network goes away between the batch and the item lookup', async () => {
    const t = await saved(2);
    t.hosted.files.delete(token(1));
    const own = t.hosted.getMediaFile.bind(t.hosted);
    t.hosted.getMediaFile = async (tok, signal) => {
      const got = await own(tok, signal);
      t.network.set(false);
      return got;
    };
    expect((await t.mirror.verify(true)).stoppedBy).toBe('hosted-unavailable');
    expect(t.mirror.summary().goneFromArtcraft).toBe(0);
  });

  it('stops without marking when the hosted user changes between the batch and the item lookup', async () => {
    const t = await saved(2);
    t.hosted.files.delete(token(1));
    const own = t.hosted.getMediaFile.bind(t.hosted);
    t.hosted.getMediaFile = async (tok, signal) => {
      const got = await own(tok, signal);
      t.hosted.user = 'someone_else';
      return got;
    };
    expect((await t.mirror.verify(true)).stoppedBy).toBe('hosted-unavailable');
    expect(t.mirror.summary().goneFromArtcraft).toBe(0);
  });

  it('does not mark an item that stopped being a saved copy while its lookup was in flight', async () => {
    const t = await saved(2);
    t.hosted.files.delete(token(1));
    t.store.removeFailures.push({ kind: 'conflict', reason: 'hash-mismatch' });
    const own = t.hosted.getMediaFile.bind(t.hosted);
    t.hosted.getMediaFile = async (tok, signal) => {
      const got = await own(tok, signal);
      // The person deletes it in this app right now; its removal cannot finish yet.
      t.events.emit({ type: 'deleted', token: tok });
      await vi.advanceTimersByTimeAsync(0);
      return got;
    };
    const result = await t.mirror.verify(true);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('removing');
    expect(result.flagged).toBe(0);
    expect((await t.journal.get(JOURNAL_ACCOUNT, token(1)))?.goneFromArtcraft).toBeFalsy();
  });

  it('marks nothing under a different hosted user or API origin than the journal belongs to', async () => {
    const t = await saved(1);
    t.hosted.files.delete(token(1));
    t.hosted.user = 'someone_else';
    expect((await t.mirror.verify(true)).stoppedBy).toBe('hosted-unavailable');
    t.hosted.user = null;
    expect((await t.mirror.verify(true)).stoppedBy).toBe('hosted-unavailable');
    t.hosted.user = ACCOUNT.username;
    t.hosted.host = 'http://localhost:12345';
    expect((await t.mirror.verify(true)).stoppedBy).toBe('hosted-unavailable');
    expect(t.mirror.summary().goneFromArtcraft).toBe(0);
  });

  it('abandons a pass when the hosted user changes while it runs', async () => {
    const t = await saved(5, { verifyChunk: 2 });
    t.hosted.files.clear();
    const real = t.hosted.getMediaFiles.bind(t.hosted);
    t.hosted.getMediaFiles = async (tokens, signal) => {
      const got = await real(tokens, signal);
      t.hosted.user = 'someone_else'; // switched account right after the first answer
      return got;
    };
    expect((await t.mirror.verify(true)).stoppedBy).toBe('hosted-unavailable');
    expect(t.mirror.summary().goneFromArtcraft).toBe(0);
  });

  it('looks only at saved items', async () => {
    const t = await saved(1);
    t.store.putFailures.push(...Array.from({ length: 5 }, () => ({ kind: 'conflict' as const, reason: 'hash-mismatch' as const })));
    t.hosted.files.set(token(2), hostedFile(2));
    await t.mirror.enqueue(token(2));
    for (let i = 0; i < 4; i++) {
      await settle(t.mirror);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(t.mirror.stateOf(token(2))?.kind).toBe('failed');
    t.hosted.calls.length = 0;
    await t.mirror.verify(true);
    expect(t.hosted.calls).toEqual(['batch:1']);
  });

  it('does not mark an item whose record changed while its lookup was running', async () => {
    const t = await saved(2);
    t.hosted.files.delete(token(1));
    const own = t.hosted.getMediaFile.bind(t.hosted);
    t.hosted.getMediaFile = async (tok, signal) => {
      const got = await own(tok, signal);
      t.events.emit({ type: 'deleted', token: token(1) }); // the person deleted it here at that moment
      await vi.advanceTimersByTimeAsync(0);
      return got;
    };
    const result = await t.mirror.verify(true);
    expect(result.flagged).toBe(0);
  });

  it('counts a shared copy only while another saved item still points at it', async () => {
    const t = setup([hostedFile(1), hostedFile(2)]);
    t.store.fixedUrl = 'https://pod.example/alice/creative-assets/2026/06/shared';
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    // The second item has not finished saving when the first one's removal runs.
    let release: () => void = () => undefined;
    t.store.gate = new Promise((resolve) => (release = resolve));
    await t.mirror.enqueue(token(2));
    await vi.advanceTimersByTimeAsync(0);
    t.store.gate = null;
    t.events.emit({ type: 'deleted', token: token(1) });
    await vi.advanceTimersByTimeAsync(0);
    release();
    await settle(t.mirror);
    // The pending item does not stand in for a saved partner: the copy went with the removal.
    expect(t.store.removed).toHaveLength(1);
  });

  it('runs on start and then at most once a day, marking what it finds', async () => {
    const files = [hostedFile(1)];
    const t = setup(files);
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.hosted.calls.filter((c) => c.startsWith('batch:'))).toHaveLength(0); // nothing was saved at start
    expect((await t.mirror.verify()).stoppedBy).toBe('too-soon'); // the pass on start has just run
    await vi.advanceTimersByTimeAsync(23 * 3_600_000);
    expect((await t.mirror.verify()).stoppedBy).toBe('too-soon');
    t.hosted.files.delete(token(1));
    await vi.advanceTimersByTimeAsync(2 * 3_600_000);
    await settle(t.mirror);
    expect(t.mirror.summary().goneFromArtcraft).toBe(1); // the daily timer found it
    expect(t.store.removed).toEqual([]);
    expect(t.hosted.calls.filter((c) => c.startsWith('batch:'))).toHaveLength(1); // not before
  });

  it('keeps the mark across a restart', async () => {
    const t = await saved(2);
    t.hosted.files.delete(token(1));
    await t.mirror.verify(true);
    await t.mirror.stop();
    const again = setup([hostedFile(2)], {}, t.journal);
    await again.mirror.start();
    await settle(again.mirror);
    expect(again.mirror.summary().goneFromArtcraft).toBe(1);
    expect(again.store.removed).toEqual([]);
  });
});

describe('deleting in this app', () => {
  it('removes the pod copy for the hosted user and API origin the journal belongs to', async () => {
    const t = setup([hostedFile(1)]);
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    t.events.emit({ type: 'deleted', token: token(1) });
    await settle(t.mirror);
    expect(t.store.removed).toHaveLength(1);
  });

  it('ignores a delete event while another hosted user or backend is signed in', async () => {
    const t = setup([hostedFile(1)]);
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    t.hosted.user = 'someone_else';
    t.events.emit({ type: 'deleted', token: token(1) });
    t.hosted.user = ACCOUNT.username;
    t.hosted.host = 'http://localhost:12345';
    t.events.emit({ type: 'deleted', token: token(1) });
    await settle(t.mirror);
    expect(t.store.removed).toEqual([]);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
  });

  it('never matches the records of another API origin, even for the same user and token', async () => {
    const t = setup([hostedFile(1)]);
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    await t.mirror.stop();
    const staging = setup([hostedFile(1)], {}, t.journal);
    staging.hosted.host = 'http://localhost:12345';
    const other = new PodMirror({
      account: ACCOUNT, journal: t.journal, hosted: staging.hosted, openStore: openFake(staging.store), fetchPublicBytes: staging.bytes.fetch,
      session: staging.session, random: () => 0.5,
    });
    await other.start();
    await settle(other);
    expect(other.stateOf(token(1))).toBeUndefined();
    await other.stop();
  });
});

describe('exposure pauses the person can act on', () => {
  it('checks again on request and goes on once the container is private', async () => {
    const t = setup([hostedFile(1)]);
    t.store.exposure = 'exposed';
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.mirror.summary()).toMatchObject({ paused: 'exposed', exposureTarget: 'https://pod.example/alice/creative-assets/' });
    t.store.exposure = 'private';
    t.mirror.recheckExposure();
    await settle(t.mirror);
    expect(t.mirror.summary()).toMatchObject({ paused: null, exposureTarget: null });
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
  });

  it('tries an inconclusive probe again by itself, with backoff', async () => {
    const t = setup([hostedFile(1)]);
    t.store.exposure = 'offline';
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    t.store.exposure = 'private';
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
  });

  it('asks the person when the pod cannot say, and writes only to the container they confirmed', async () => {
    const t = setup([hostedFile(1), hostedFile(2)]);
    t.store.exposure = 'unknown';
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.mirror.summary()).toMatchObject({ paused: 'exposure-unknown', exposureTarget: 'https://pod.example/alice/creative-assets/' });
    expect(t.store.puts).toEqual([]);
    expect(t.open.calls).toBe(1);
    expect(t.open.allowed[0]('https://pod.example/alice/creative-assets/')).toBe(false);

    expect(await t.mirror.confirmPrivate()).toBe(true);
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
    // The same store is kept; the store's own per-container question now answers yes for the
    // confirmed library and its shards, and no for any other container.
    expect(t.open.calls).toBe(1);
    const allowed = t.open.allowed[0];
    expect(allowed('https://pod.example/alice/creative-assets/')).toBe(true);
    expect(allowed('https://pod.example/alice/creative-assets/2026/06/')).toBe(true);
    expect(allowed('https://pod.example/alice/creative-assets-evil/')).toBe(false);
    expect(allowed('https://pod.example/alice/other-library/')).toBe(false);
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.confirmedPrivate).toEqual(['https://pod.example/alice/creative-assets/']);

    // Nothing is left to confirm, so a second confirmation is not accepted.
    expect(await t.mirror.confirmPrivate()).toBe(false);

    // A different container is not covered by the earlier confirmation.
    t.store.target = 'https://pod.example/alice/other-library/';
    await t.mirror.stop();
    const again = setup([hostedFile(2)], {}, t.journal);
    again.store.exposure = 'unknown';
    again.store.target = 'https://pod.example/alice/other-library/';
    await again.mirror.start();
    await again.mirror.enqueue(token(2));
    await settle(again.mirror);
    expect(again.mirror.summary().paused).toBe('exposure-unknown');
    expect(again.store.puts).toEqual([]);
  });

  it('asks about the library the store reports before the first save, and confirms exactly that URL', async () => {
    const LIBRARY = 'https://pod.example/alice/creative-assets/';
    const t = setup([hostedFile(1)]);
    t.store.exposure = 'unknown';
    t.store.target = LIBRARY;
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.store.ensured).toBeGreaterThan(0);
    expect(t.store.puts).toEqual([]);
    expect(t.mirror.summary()).toMatchObject({ paused: 'exposure-unknown', exposureTarget: LIBRARY });
    expect(await t.mirror.confirmPrivate()).toBe(true);
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.confirmedPrivate).toEqual([LIBRARY]);
    const allowed = t.open.allowed[0];
    expect(allowed('https://pod.example/alice/')).toBe(false);
    expect(allowed('https://pod.example/alice/public/')).toBe(false);
    expect(allowed(`${LIBRARY}2026/06/`)).toBe(true);
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
  });

  it('proceeds without asking when the library is reported private, and writes nothing before that answer', async () => {
    const t = setup([hostedFile(1)]);
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.mirror.summary().paused).toBeNull();
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
  });

  it('pauses with a "check again" state when no library exists and the storage root is not safe, and never offers the root', async () => {
    const ROOT = 'https://pod.example/alice/';
    const t = setup([hostedFile(1)]);
    t.store.exposure = 'unknown';
    t.store.target = ROOT;
    t.store.library = null;
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.mirror.summary()).toMatchObject({ paused: 'storage-unsafe', exposureTarget: ROOT });
    expect(t.store.puts).toEqual([]);
    expect(await t.mirror.confirmPrivate()).toBe(false);
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.confirmedPrivate).toBeUndefined();
    expect(t.open.allowed[0](ROOT)).toBe(false);
    // Fixed on the pod: checking again finds a private library and the queue goes on.
    t.store.library = undefined;
    t.store.target = 'https://pod.example/alice/creative-assets/';
    t.store.exposure = 'private';
    t.mirror.recheckExposure();
    await settle(t.mirror);
    expect(t.mirror.summary().paused).toBeNull();
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
  });

  it('treats an exposed storage root the same way, and an exposed library as exposed', async () => {
    const t = setup([hostedFile(1)]);
    t.store.exposure = 'exposed';
    t.store.library = null;
    await t.mirror.start();
    await settle(t.mirror);
    expect(t.mirror.summary().paused).toBe('storage-unsafe');
    t.store.library = undefined;
    t.mirror.recheckExposure();
    await settle(t.mirror);
    expect(t.mirror.summary().paused).toBe('exposed');
    expect(await t.mirror.confirmPrivate()).toBe(false);
  });

  it('honours a confirmed library and what is beneath it, never a container that only shares its start', async () => {
    const journal = createMemoryMirrorJournal();
    await journal.updateAccountState(JOURNAL_ACCOUNT, { confirmedPrivate: ['https://pod.example/alice/lib'] });
    const t = setup([], {}, journal);
    t.store.exposure = 'unknown';
    t.store.target = 'https://pod.example/alice/lib';
    await t.mirror.start();
    await settle(t.mirror);
    const allowed = t.open.allowed[0];
    expect(allowed('https://pod.example/alice/lib')).toBe(true);
    expect(allowed('https://pod.example/alice/lib/2026/06/')).toBe(true);
    expect(allowed('https://pod.example/alice/lib-evil/')).toBe(false);
    expect(allowed('https://pod.example/alice/library/')).toBe(false);
  });

  it('remembers the confirmation across a restart and never extends it to an exposed answer', async () => {
    const t = setup([hostedFile(1)]);
    t.store.exposure = 'unknown';
    await t.mirror.start();
    await settle(t.mirror);
    await t.mirror.confirmPrivate();
    await t.mirror.stop();
    const again = setup([hostedFile(1)], {}, t.journal);
    again.store.exposure = 'unknown';
    await again.mirror.start();
    await again.mirror.enqueue(token(1));
    await settle(again.mirror);
    expect(again.mirror.stateOf(token(1))?.kind).toBe('saved');
    expect(again.open.allowed[0]('https://pod.example/alice/creative-assets/')).toBe(true);
    await again.mirror.stop();
    const exposed = setup([hostedFile(2)], {}, t.journal);
    exposed.store.exposure = 'exposed';
    await exposed.mirror.start();
    await exposed.mirror.enqueue(token(2));
    await settle(exposed.mirror);
    expect(exposed.mirror.summary().paused).toBe('exposed');
    expect(exposed.store.puts).toEqual([]);
    expect(await exposed.mirror.confirmPrivate()).toBe(false);
  });

  it('treats a container below a confirmed one as confirmed', async () => {
    const t = setup([hostedFile(1)]);
    t.store.target = 'https://pod.example/alice/';
    t.store.exposure = 'unknown';
    await t.mirror.start();
    await settle(t.mirror);
    await t.mirror.confirmPrivate();
    await t.mirror.stop();
    const again = setup([hostedFile(1)], {}, t.journal);
    again.store.exposure = 'unknown';
    again.store.target = 'https://pod.example/alice/creative-assets/';
    await again.mirror.start();
    await settle(again.mirror);
    expect(again.mirror.summary().paused).toBeNull();
  });
});

describe('races between a hosted delete and a copy', () => {
  it('removes the copy of an item deleted while it was being written, even after a duplicate added event', async () => {
    const t = setup([hostedFile(1)]);
    let release: () => void = () => undefined;
    t.store.gate = new Promise((resolve) => (release = resolve));
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await vi.advanceTimersByTimeAsync(0);
    t.events.emit({ type: 'deleted', token: token(1) });
    t.events.emit({ type: 'added', tokens: [token(1)] });
    await vi.advanceTimersByTimeAsync(0);
    // The write is not cut short: a copy the pod accepted would be left with nothing pointing at it.
    expect((t.store.puts[0] as { signal?: AbortSignal }).signal?.aborted).toBe(false);
    release();
    await settle(t.mirror);
    expect(t.store.removed).toHaveLength(1);
    expect(t.mirror.stateOf(token(1))).toBeUndefined();
  });
});

describe('stopping and losing the session mid-copy', () => {
  const inFlight = async () => {
    const t = setup([hostedFile(1)]);
    let release: () => void = () => undefined;
    t.store.gate = new Promise((resolve) => (release = resolve));
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.store.puts).toHaveLength(1);
    const signal = (t.store.puts[0] as { signal: AbortSignal }).signal;
    return { t, release, signal };
  };

  it('aborts the write when the mirror stops, and counts nothing against the item', async () => {
    const { t, release, signal } = await inFlight();
    t.store.putFailures.push({ kind: 'failed', reason: 'unexpected' });
    const stopping = t.mirror.stop();
    expect(signal.aborted).toBe(true);
    release();
    await stopping;
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'pending', attempts: 0 });
    expect((await t.journal.get(JOURNAL_ACCOUNT, token(1)))?.attempts).toBe(0);
  });

  it('aborts the write when the pod session ends, and counts nothing against the item', async () => {
    const { t, release, signal } = await inFlight();
    t.store.putFailures.push({ kind: 'failed', reason: 'unexpected' });
    t.session.set(false);
    expect(signal.aborted).toBe(true);
    release();
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'pending', attempts: 0 });
  });

  it('does not count a failure that arrives after the network went away unnoticed', async () => {
    const { t, release } = await inFlight();
    t.store.putFailures.push({ kind: 'failed', reason: 'unexpected' });
    t.network.online = false; // no event yet, so nothing was aborted
    release();
    await vi.advanceTimersByTimeAsync(0);
    await t.mirror.idle();
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'pending', attempts: 0 });
  });

  it('does not count a failure that arrives after the session went away unnoticed', async () => {
    const { t, release } = await inFlight();
    t.store.putFailures.push({ kind: 'failed', reason: 'unexpected' });
    t.session.connected = false;
    release();
    await vi.advanceTimersByTimeAsync(0);
    await t.mirror.idle();
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'pending', attempts: 0 });
  });

  it('opens the store again when the session reconnects, even from a connected state', async () => {
    const t = setup([hostedFile(1)]);
    await t.mirror.start();
    await settle(t.mirror);
    expect(t.open.calls).toBe(1);
    t.session.set(true);
    await settle(t.mirror);
    expect(t.open.calls).toBe(2);
  });

  it('does not use a store that finished opening after the session changed', async () => {
    const t = setup([hostedFile(1)]);
    let finish: (value: { ok: true; store: ReturnType<typeof fakeStore> }) => void = () => undefined;
    const stale = fakeStore();
    const fresh = fakeStore();
    void fresh;
    let calls = 0;
    const mirror = new PodMirror({
      account: ACCOUNT, journal: t.journal, hosted: t.hosted, fetchPublicBytes: t.bytes.fetch, session: t.session, random: () => 0.5,
      openStore: (async () => {
        calls++;
        if (calls === 1) return new Promise((resolve) => (finish = resolve as typeof finish));
        return { ok: true as const, store: fresh };
      }) as unknown as OpenStore,
    });
    await mirror.start();
    await vi.advanceTimersByTimeAsync(0);
    t.session.set(true); // the session changed while the store was opening
    await vi.advanceTimersByTimeAsync(0);
    finish({ ok: true, store: stale });
    await vi.advanceTimersByTimeAsync(0);
    await mirror.enqueue(token(1));
    await vi.advanceTimersByTimeAsync(0);
    await mirror.idle();
    await vi.advanceTimersByTimeAsync(60_000);
    await mirror.idle();
    expect(stale.puts).toEqual([]);
    await mirror.stop();
  });
});

describe('what the hosted side says about an item', () => {
  it('holds an item back while its prompt cannot be read, then saves it with the prompt', async () => {
    const file = hostedFile(1, { maybe_prompt_token: 'p_1' });
    const t = setup([file]);
    t.hosted.prompts.set('p_1', hostedPrompt('p_1'));
    t.hosted.down.add('p_1');
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    expect(t.store.puts).toEqual([]);
    expect(t.mirror.stateOf(file.token)).toEqual({ kind: 'pending', attempts: 1, lastError: 'hosted-unavailable' });
    t.hosted.down.clear();
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(t.mirror);
    expect((t.store.puts[0] as { description: { generation?: { prompt?: string } } }).description.generation?.prompt).toBe('a red fox at sunset');
  });

  it('does not link a reference image that is not saved', async () => {
    const reference = hostedFile(2);
    const file = hostedFile(1, { maybe_prompt_token: 'p_1' });
    const t = setup([file, reference]);
    t.hosted.prompts.set('p_1', hostedPrompt('p_1', { maybe_context_images: [{ media_token: token(2), semantic: 'reference' }] }));
    for (let i = 0; i < 3; i++) t.store.putFailures.push({ kind: 'conflict', reason: 'hash-mismatch' }); // the reference ends failed
    await t.mirror.start();
    await t.mirror.enqueue(token(2));
    for (let i = 0; i < 4; i++) {
      await settle(t.mirror);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(t.mirror.stateOf(token(2))?.kind).toBe('failed');
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    const put = t.store.puts[1] as { description: { generation?: { usedAssets?: string[] } } };
    expect(put.description.generation?.usedAssets).toBeUndefined();
  });

  it('does not link a reference image that is only pending, even when it names a description', async () => {
    const reference = hostedFile(2);
    const file = hostedFile(1, { maybe_prompt_token: 'p_1' });
    const t = setup([file, reference]);
    t.hosted.prompts.set('p_1', hostedPrompt('p_1', { maybe_context_images: [{ media_token: token(2), semantic: 'reference' }] }));
    await t.journal.create({ ...JOURNAL_ACCOUNT, token: token(2), state: 'pending', attempts: 1, descriptionUrl: 'https://pod.example/media/stale', createdAt: 1, updatedAt: 1 });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    const put = t.store.puts.find((p) => (p as { description: { generation?: unknown } }).description.generation) as { description: { generation?: { usedAssets?: string[] } } } | undefined;
    expect(put?.description.generation?.usedAssets).toBeUndefined();
  });

  it.each([
    ['a PLY splat', 'ply', ply, '.ply'],
    ['an SPZ splat declared by its media type', 'spz', spz, '.spz'],
  ])('saves %s as a 3D asset with the sniffed type', async (_name, mediaType, bytesOf, extension) => {
    const file = hostedFile(1, { media_type: mediaType, media_class: 'splat', media_links: { cdn_url: 'https://cdn.example/files/1.bin', thumbnail_template: '' } });
    const t = setup([file]);
    t.bytes.bodies.set(file.media_links.cdn_url, bytesOf());
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    expect(t.mirror.stateOf(file.token)).toMatchObject({ kind: 'saved' });
    expect(t.store.puts[0]).toMatchObject({ contentType: 'application/octet-stream', extension, description: { kind: 'model3d' } });
  });

  it('does not take an SPZ for granted: undeclared bytes with that header stay unsupported', async () => {
    const file = hostedFile(1, { media_type: 'glb', media_class: 'mesh' });
    const t = setup([file]);
    t.bytes.bodies.set(file.media_links.cdn_url, spz());
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    expect(t.mirror.stateOf(file.token)).toEqual({ kind: 'skipped', reason: 'unsupported-type' });
  });

  it('skips a mesh format the sniffer does not know, such as FBX', async () => {
    const file = hostedFile(1, { media_type: 'fbx', media_class: 'mesh' });
    const t = setup([file]);
    t.bytes.bodies.set(file.media_links.cdn_url, new TextEncoder().encode('Kaydara FBX Binary  \0\x1a\0'));
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    expect(t.mirror.stateOf(file.token)).toEqual({ kind: 'skipped', reason: 'unsupported-type' });
  });

  it('hands the store the downloaded Blob itself and lets files up to the store limit through', async () => {
    const file = hostedFile(1);
    const limits: number[] = [];
    const base = fakeBytes(fakeHosted([file]));
    const t = setup([file], {
      fetchPublicBytes: async (url, options) => {
        if (url === file.media_links.cdn_url) limits.push(options.maxBytes);
        return base.fetch(url, options);
      },
    });
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    expect((t.store.puts[0] as { bytes: unknown }).bytes).toBeInstanceOf(Blob);
    expect(limits).toEqual([DEFAULT_MAX_BYTES]);
    expect(DEFAULT_MAX_BYTES).toBeGreaterThan(16 * 1024 * 1024);
  });

  it('does not fetch a thumbnail for a 3D model', async () => {
    const file = hostedFile(1, { media_type: 'glb', media_class: 'mesh', media_links: { cdn_url: 'https://cdn.example/files/1.glb', thumbnail_template: 'https://cdn.example/thumbs/1/{WIDTH}.png' } });
    const t = setup([file]);
    t.bytes.bodies.set(file.media_links.cdn_url, glb());
    t.bytes.bodies.set('https://cdn.example/thumbs/1/512.png', png(1));
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    expect(t.mirror.stateOf(file.token)).toMatchObject({ kind: 'saved', thumbnail: 'none' });
    expect(t.bytes.urls).not.toContain('https://cdn.example/thumbs/1/512.png');
  });

  it('skips a 3D record whose bytes are a cover image, instead of mirroring the image as the model', async () => {
    const file = hostedFile(1, { media_type: 'glb', media_class: 'mesh' });
    const t = setup([file]);
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    expect(t.mirror.stateOf(file.token)).toEqual({ kind: 'skipped', reason: 'unsupported-type' });
    expect(t.store.puts).toEqual([]);
  });

  it('copies a record whose media_type is a format it has never seen, when the bytes are an image', async () => {
    const file = hostedFile(1, { media_type: 'avif_future', media_class: null });
    const t = setup([file]);
    await t.mirror.start();
    await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    expect(t.mirror.stateOf(file.token)?.kind).toBe('saved');
  });
});

describe('a saved item whose pod copy is gone', () => {
  const saved = async (files = [hostedFile(1)]) => {
    const t = setup(files);
    await t.mirror.start();
    for (const file of files) await t.mirror.enqueue(file.token);
    await settle(t.mirror);
    return t;
  };
  const urlOf = (t: Awaited<ReturnType<typeof saved>>, n = 1) => (t.mirror.stateOf(token(n)) as { descriptionUrl: string }).descriptionUrl;

  it('is queued to be copied again when the pod answers 404 and the hosted item still exists, and nothing is deleted', async () => {
    const t = await saved();
    const before = urlOf(t);
    t.store.missing.add(before);
    t.store.fixedUrl = before; // the same bytes land at the same address
    const result = await t.mirror.verify(true);
    await settle(t.mirror);
    expect(result).toMatchObject({ checked: 1, flagged: 0, requeued: 1, stoppedBy: 'done' });
    expect(t.store.puts).toHaveLength(2);
    expect(t.mirror.stateOf(token(1))).toMatchObject({ kind: 'saved', descriptionUrl: before });
    expect(t.store.missing.size).toBe(0);
    expect(t.store.removed).toEqual([]);
  });

  it('is not requeued on a network error, 401/403, a server error or an unreadable description', async () => {
    const t = await saved();
    t.store.missing.add(urlOf(t));
    const failures = [
      { kind: 'offline', reason: 'storage' },
      { kind: 'forbidden', reason: 'storage' },
      { kind: 'failed', reason: 'storage' },
      { kind: 'failed', reason: 'description-unparseable' },
      { kind: 'not-found', reason: 'out-of-scope' },
    ] as const;
    for (const failure of failures) {
      t.store.getFailure = failure;
      const result = await t.mirror.verify(true);
      await settle(t.mirror);
      expect(result.requeued).toBe(0);
      expect(t.mirror.stateOf(token(1))).toMatchObject({ kind: 'saved' });
    }
    expect(t.store.puts).toHaveLength(1);
    expect(t.store.removed).toEqual([]);
  });

  it('does not record the pod pass as done when the pod could not be asked, so the next start tries again, and does not repeat the hosted pass', async () => {
    const t = await saved();
    await t.journal.updateAccountState(JOURNAL_ACCOUNT, { verifiedAt: undefined, podVerifiedAt: undefined });
    t.store.getFailure = { kind: 'offline', reason: 'storage' };
    expect(await t.mirror.verify(true)).toMatchObject({ stoppedBy: 'pod-unavailable' });
    const state = await t.journal.getAccountState(JOURNAL_ACCOUNT);
    expect(state?.podVerifiedAt).toBeUndefined();
    // The hosted half did run, and is recorded on its own.
    expect(state?.verifiedAt).toBeDefined();
  });

  it('is not copied again when the hosted item is gone too: it is only marked, as before', async () => {
    const t = await saved();
    t.store.missing.add(urlOf(t));
    t.hosted.files.delete(token(1));
    const result = await t.mirror.verify(true);
    await settle(t.mirror);
    expect(result).toMatchObject({ flagged: 1, requeued: 0 });
    expect(t.store.puts).toHaveLength(1);
    expect(t.mirror.stateOf(token(1))).toMatchObject({ kind: 'saved' });
  });

  it('asks the pod once per copy, and requeues every token that pointed at it', async () => {
    const t = setup([hostedFile(1), hostedFile(2)]);
    t.store.fixedUrl = 'https://pod.example/alice/creative-assets/2026/06/shared';
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await t.mirror.enqueue(token(2));
    await settle(t.mirror);
    t.store.missing.add(t.store.fixedUrl);
    t.store.gets.length = 0;
    const result = await t.mirror.verify(true);
    await settle(t.mirror);
    expect(result.requeued).toBe(2);
    expect(t.store.gets).toHaveLength(1);
    expect(t.mirror.summary().counts.saved).toBe(2);
  });
});

describe('the pod check believes a 404 only with a second opinion and under a ceiling', () => {
  const urlFor = (n: number) => `https://pod.example/alice/creative-assets/2026/06/d${n}`;
  const COUNT = 40;
  /** A mirror whose journal already holds `COUNT` saved items, each at its own address. */
  const library = async (overrides: Partial<PodMirrorOptions> = {}, journal = createMemoryMirrorJournal()) => {
    await journal.ensureBaseline(JOURNAL_ACCOUNT, { kind: 'empty' });
    for (let n = 1; n <= COUNT; n++) {
      await journal.create({ ...JOURNAL_ACCOUNT, token: token(n), state: 'saved', attempts: 0, createdAt: 1, updatedAt: 1, descriptionUrl: urlFor(n) });
    }
    const t = setup(Array.from({ length: COUNT }, (_, i) => hostedFile(i + 1)), overrides, journal);
    // Not at start: these tests ask for the pass themselves.
    await journal.updateAccountState(JOURNAL_ACCOUNT, { verifiedAt: Date.now(), podVerifiedAt: Date.now() });
    return t;
  };

  it('requeues nothing when the pod answers 404 for everything, and raises library-missing', async () => {
    const t = await library();
    await t.mirror.start();
    await settle(t.mirror);
    t.store.getFailure = { kind: 'not-found', reason: 'storage' };
    const result = await t.mirror.verify(true);
    await settle(t.mirror);
    expect(result.stoppedBy).toBe('library-missing');
    expect(result.requeued).toBe(0);
    expect(t.mirror.summary().counts).toMatchObject({ saved: COUNT, pending: 0 });
    expect(t.mirror.summary().libraryMissing).toMatchObject({ missing: expect.any(Number) });
    expect(t.store.puts).toHaveLength(0);
    expect(t.bytes.urls).toHaveLength(0);
    // It stopped as soon as the ceiling was passed, not after asking about everything.
    expect(t.store.gets.length).toBeLessThan(COUNT);
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.libraryMissing).toBeDefined();
  });

  it('does not run again, nor lose the flag across a restart, until the person chooses', async () => {
    const t = await library();
    await t.mirror.start();
    t.store.getFailure = { kind: 'not-found', reason: 'storage' };
    await t.mirror.verify(true);
    await t.mirror.stop();
    const again = setup(Array.from({ length: COUNT }, (_, i) => hostedFile(i + 1)), {}, t.journal);
    await again.mirror.start();
    await settle(again.mirror);
    expect(again.mirror.summary().libraryMissing).not.toBeNull();
    expect((await again.mirror.verify(true)).stoppedBy).toBe('library-missing');
    expect(again.store.gets).toHaveLength(0);
  });

  it('copies again only on the person\'s say-so, the items the hosted side still has', async () => {
    const t = await library();
    await t.mirror.start();
    t.store.getFailure = { kind: 'not-found', reason: 'storage' };
    await t.mirror.verify(true);
    const flagged = t.mirror.summary().libraryMissing?.missing ?? 0;
    expect(flagged).toBeGreaterThan(5);
    t.store.getFailure = null;
    t.hosted.files.delete(token(1)); // gone from the hosted side too: not copied again
    const queued = await t.mirror.copyAgain();
    await settle(t.mirror);
    expect(queued).toBe(flagged - 1);
    expect(t.mirror.summary().libraryMissing).toBeNull();
    expect(t.store.puts).toHaveLength(queued);
    expect(t.mirror.summary().counts.saved).toBe(COUNT);
    expect(await t.mirror.copyAgain()).toBe(0);
  });

  it('requeues a few missing copies, paced through the normal queue', async () => {
    const t = await library({ concurrency: 2 });
    await t.mirror.start();
    await settle(t.mirror);
    for (const n of [3, 7, 11]) t.store.missing.add(urlFor(n));
    const result = await t.mirror.verify(true);
    expect(result).toMatchObject({ requeued: 3, stoppedBy: 'done' });
    expect(t.mirror.summary().libraryMissing).toBeNull();
    await settle(t.mirror);
    expect(t.store.puts).toHaveLength(3);
    expect(t.mirror.summary().counts.saved).toBe(COUNT);
  });

  it('stops as "cannot tell" when the library container itself does not answer, however the items answer', async () => {
    const t = await library();
    await t.mirror.start();
    t.store.libraryProbe = 'unknown';
    t.store.getFailure = { kind: 'not-found', reason: 'storage' };
    const result = await t.mirror.verify(true);
    expect(result.stoppedBy).toBe('pod-unavailable');
    expect(t.store.gets).toHaveLength(0);
    expect(t.mirror.summary().counts.pending).toBe(0);
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.podVerifiedAt).toBeLessThanOrEqual(Date.now());
  });

  it('raises library-missing at once when the pod says the library is not there, without a request per item', async () => {
    const t = await library();
    await t.mirror.start();
    t.store.libraryProbe = 'missing';
    const result = await t.mirror.verify(true);
    expect(result.stoppedBy).toBe('library-missing');
    expect(t.store.gets).toHaveLength(0);
    expect(t.mirror.summary().counts.pending).toBe(0);
  });

  it('continues an interrupted pass from its cursor instead of starting again, and a stop ends it at once', async () => {
    const t = await library();
    await t.mirror.start();
    await settle(t.mirror);
    for (const n of [35, 39]) t.store.missing.add(urlFor(n));
    const realGet = t.store.get.bind(t.store);
    t.store.get = async (url, signal) => {
      if (t.store.gets.length === 10) void t.mirror.stop();
      return realGet(url, signal);
    };
    const first = await t.mirror.verify(true);
    expect(first.stoppedBy).not.toBe('done');
    const askedFirst = t.store.gets.length;
    expect(askedFirst).toBeLessThan(COUNT);
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.podCheck).toBeDefined();

    const again = setup(Array.from({ length: COUNT }, (_, i) => hostedFile(i + 1)), {}, t.journal);
    for (const n of [35, 39]) again.store.missing.add(urlFor(n));
    await again.mirror.start();
    await settle(again.mirror);
    await again.mirror.verify(true);
    await settle(again.mirror);
    // Between them the two passes asked about each copy once, and the two missing ones were requeued and saved again.
    expect(askedFirst + again.store.gets.length).toBeLessThanOrEqual(COUNT + 1);
    expect(again.store.puts).toHaveLength(2);
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.podCheck).toBeUndefined();
  });
});

describe('a journal whose connection was closed by another window', () => {
  it('pauses with journal-closed: nothing more is copied or removed, and the summary says a reload is needed', async () => {
    const journal = createMemoryMirrorJournal();
    let close: () => void = () => undefined;
    journal.onClose = (listener) => {
      close = listener;
      return () => undefined;
    };
    const t = setup([hostedFile(1), hostedFile(2)], {}, journal);
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.store.puts).toHaveLength(1);
    close();
    expect(t.mirror.summary().paused).toBe('journal-closed');
    await t.mirror.enqueue(token(2));
    t.events.emit({ type: 'deleted', token: token(1) });
    await settle(t.mirror);
    expect(t.store.puts).toHaveLength(1);
    expect(t.store.removed).toEqual([]);
  });
});

describe('a journal that cannot be written', () => {
  const URL_ = 'https://pod.example/alice/creative-assets/2026/06/shared';

  it('does not leave an item saved in memory only: it stays not saved, says so, and is saved once the journal works', async () => {
    const t = setup([hostedFile(1)]);
    t.store.fixedUrl = URL_;
    await t.mirror.start();
    const real = t.journal.update.bind(t.journal);
    let failing = true;
    t.journal.update = async (account, tok, patch, now) => {
      if (failing && patch.state === 'saved') throw new Error('QuotaExceededError');
      return real(account, tok, patch, now);
    };
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).not.toBe('saved');
    expect(await t.journal.get(JOURNAL_ACCOUNT, token(1))).not.toMatchObject({ state: 'saved' });
    failing = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toMatchObject({ kind: 'saved', descriptionUrl: URL_ });
    expect(await t.journal.get(JOURNAL_ACCOUNT, token(1))).toMatchObject({ state: 'saved' });
    expect(t.mirror.summary().journalUnavailable).toBe(false);
  });

  it('raises journalUnavailable while writes fail', async () => {
    const t = setup([hostedFile(1)]);
    await t.mirror.start();
    t.journal.update = async () => {
      throw new Error('closed');
    };
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.mirror.summary().journalUnavailable).toBe(true);
  });

  it('deletes nothing from the pod while the journal cannot be written, and does once it can', async () => {
    const t = setup([hostedFile(1)]);
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    const url = (t.mirror.stateOf(token(1)) as { descriptionUrl: string }).descriptionUrl;
    const real = t.journal.update.bind(t.journal);
    let failing = true;
    t.journal.update = async (account, tok, patch, now) => {
      if (failing) throw new Error('closed');
      return real(account, tok, patch, now);
    };
    t.events.emit({ type: 'deleted', token: token(1) });
    await settle(t.mirror);
    expect(t.store.removed).toEqual([]);
    failing = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(t.mirror);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(t.mirror);
    expect(t.store.removed).toEqual([url]);
  });

  it('a second account whose saved write failed is not counted as pairing, but its copy is written again after another account deleted it', async () => {
    const journal = createMemoryMirrorJournal();
    const store = fakeStore();
    store.fixedUrl = URL_;
    const make = (username: string) => {
      const hosted = fakeHosted([hostedFile(1)]);
      hosted.user = username;
      const events = fakeEvents();
      const mirror = new PodMirror({ account: { webId: ACCOUNT.webId, username }, journal, hosted, openStore: openFake(store), fetchPublicBytes: fakeBytes(hosted).fetch, session: fakeSession(), network: fakeNetwork(), events, random: () => 0.5 });
      return { mirror, events };
    };
    const a = make('alice_hosted');
    const b = make('bob_hosted');
    await a.mirror.start();
    await a.mirror.enqueue(token(1));
    await settle(a.mirror);
    await b.mirror.start();
    const real = journal.update.bind(journal);
    let failing = true;
    journal.update = async (account, tok, patch, now) => {
      if (failing && account.username.startsWith('bob') && patch.state === 'saved') throw new Error('QuotaExceededError');
      return real(account, tok, patch, now);
    };
    await b.mirror.enqueue(token(1));
    await settle(b.mirror);
    expect(b.mirror.stateOf(token(1))?.kind).not.toBe('saved');
    a.events.emit({ type: 'deleted', token: token(1) });
    await settle(a.mirror);
    failing = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(b.mirror);
    // Whatever the order, bob ends saved on a copy that is there.
    expect(b.mirror.stateOf(token(1))).toMatchObject({ kind: 'saved', descriptionUrl: URL_ });
    expect((await store.get(URL_)).ok).toBe(true);
  });
});

describe('an item the pod check queued to be copied again', () => {
  const savedItem = async () => {
    const t = setup([hostedFile(1)]);
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    const url = (t.mirror.stateOf(token(1)) as { descriptionUrl: string }).descriptionUrl;
    return { t, url };
  };

  it('is removed by a hosted delete that comes before the new copy exists, using the address it had', async () => {
    const { t, url } = await savedItem();
    // One false 404 queues it; the new copy cannot be written yet.
    t.store.getFailure = { kind: 'not-found', reason: 'storage' };
    t.store.putFailures.push({ kind: 'offline', reason: 'storage' });
    await t.mirror.verify(true);
    await settle(t.mirror);
    t.store.getFailure = null;
    expect(t.mirror.stateOf(token(1))?.kind).toBe('pending');
    t.events.emit({ type: 'deleted', token: token(1) });
    await settle(t.mirror);
    expect(t.store.removed).toEqual([url]);
    expect(t.mirror.stateOf(token(1))).toBeUndefined();
  });

  it('is no longer the import run\'s: cancelling the run does not drop it, and pausing it does not hold it', async () => {
    const journal = createMemoryMirrorJournal();
    await journal.ensureBaseline(JOURNAL_ACCOUNT, { kind: 'item', token: token(5), createdAt: new Date(hostedFile(5).created_at).getTime() });
    const t = setup(Array.from({ length: 5 }, (_, i) => hostedFile(i + 1)), {}, journal);
    await t.mirror.start();
    await settle(t.mirror);
    await t.mirror.startImport(5);
    for (let i = 0; i < 20; i++) await settle(t.mirror);
    expect(t.mirror.summary().import).toMatchObject({ state: 'done', saved: 5 });
    await t.mirror.startImport(5);
    await t.mirror.pauseImport();
    const url = (t.mirror.stateOf(token(1)) as { descriptionUrl: string }).descriptionUrl;
    t.store.missing.add(url);
    t.store.fixedUrl = url;
    await t.mirror.verify(true);
    await settle(t.mirror);
    // The run is paused, yet the item is copied again.
    expect(t.mirror.stateOf(token(1))).toMatchObject({ kind: 'saved' });
    await t.mirror.cancelImport();
    await settle(t.mirror);
    expect(await journal.get(JOURNAL_ACCOUNT, token(1))).toMatchObject({ state: 'saved' });
  });

  it('keeps a record whose copy the store cannot place (out of scope), but drops one the pod says is not there', async () => {
    const { t, url } = await savedItem();
    t.store.removeFailures.push({ kind: 'not-found', reason: 'out-of-scope' });
    t.events.emit({ type: 'deleted', token: token(1) });
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('removing');
    t.store.missing.add(url);
    t.store.removeFailures.push({ kind: 'not-found', reason: 'storage' });
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toBeUndefined();
  });
});

describe('the verification pass at start', () => {
  const URL_ = 'https://pod.example/alice/creative-assets/2026/06/gone';
  const seeded = async () => {
    const journal = createMemoryMirrorJournal();
    await journal.ensureBaseline(JOURNAL_ACCOUNT, { kind: 'empty' });
    await journal.create({ ...JOURNAL_ACCOUNT, token: token(1), state: 'saved', attempts: 0, createdAt: 1, updatedAt: 1, descriptionUrl: URL_ });
    return journal;
  };
  const batches = (t: ReturnType<typeof setup>) => t.hosted.calls.filter((c) => c.startsWith('batch')).length;

  it('asks the pod after the store opens, with no forced pass, and requeues a copy the pod says is gone', async () => {
    const t = setup([hostedFile(1)], {}, await seeded());
    t.store.missing.add(URL_);
    await t.mirror.start();
    await settle(t.mirror);
    expect(t.store.gets).toContain(URL_);
    expect(t.store.puts).toHaveLength(1);
    expect(t.mirror.stateOf(token(1))).toMatchObject({ kind: 'saved' });
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.podVerifiedAt).toBeDefined();
  });

  it('still asks the pod when the store takes a while to open', async () => {
    const t = setup([hostedFile(1)], {}, await seeded());
    t.store.missing.add(URL_);
    const inner = t.open;
    const slow = (async (signal: AbortSignal, options: never) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return inner(signal, options);
    }) as unknown as OpenStore;
    const mirror = new PodMirror({ account: ACCOUNT, journal: t.journal, hosted: t.hosted, openStore: slow, fetchPublicBytes: t.bytes.fetch, session: t.session, network: t.network, events: t.events, random: () => 0.5 });
    await mirror.start();
    await vi.advanceTimersByTimeAsync(60);
    await settle(mirror);
    expect(t.store.gets).toContain(URL_);
    expect(t.store.puts).toHaveLength(1);
  });

  it('records the hosted pass and the pod pass apart: a start where the pod cannot be reached does not make the hosted check repeat', async () => {
    const journal = await seeded();
    const first = setup([hostedFile(1)], {}, journal);
    first.open.fail = 'offline';
    await first.mirror.start();
    await settle(first.mirror);
    expect(batches(first)).toBe(1);
    expect(first.store.gets).toHaveLength(0);
    let state = await journal.getAccountState(JOURNAL_ACCOUNT);
    expect(state?.verifiedAt).toBeDefined();
    expect(state?.podVerifiedAt).toBeUndefined();
    await first.mirror.stop();

    // Five minutes later the pod answers: only the pod half runs.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    const second = setup([hostedFile(1)], {}, journal);
    await second.mirror.start();
    await settle(second.mirror);
    expect(batches(second)).toBe(0);
    expect(second.store.gets).toContain(URL_);
    state = await journal.getAccountState(JOURNAL_ACCOUNT);
    expect(state?.podVerifiedAt).toBeDefined();
    await second.mirror.stop();

    // A third start inside the hour repeats neither.
    vi.setSystemTime(Date.now() + 5 * 60_000);
    const third = setup([hostedFile(1)], {}, journal);
    await third.mirror.start();
    await settle(third.mirror);
    expect(batches(third)).toBe(0);
    expect(third.store.gets).toHaveLength(0);
  });

  it('runs the pod pass once the store opens after an earlier failed open, without a restart', async () => {
    const t = setup([hostedFile(1)], {}, await seeded());
    t.open.fail = 'failed';
    t.store.missing.add(URL_);
    await t.mirror.start();
    await settle(t.mirror);
    expect(t.store.gets).toHaveLength(0);
    t.open.fail = null;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(t.mirror);
    expect(t.store.gets).toContain(URL_);
  });
});

describe('bytes in flight', () => {
  it('starts a second upload only when its bytes fit, however many items the concurrency allows', async () => {
    // Each item is a 32-byte file plus a 32-byte thumbnail.
    const t = setup([hostedFile(1), hostedFile(2)], { concurrency: 2, maxBytesInFlight: 100 });
    let release: () => void = () => undefined;
    t.store.gate = new Promise<void>((resolve) => (release = resolve));
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await t.mirror.enqueue(token(2));
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0);
    expect(t.store.puts).toHaveLength(1);
    t.store.gate = null;
    release();
    await settle(t.mirror);
    expect(t.store.puts).toHaveLength(2);
    expect(t.mirror.summary().counts.saved).toBe(2);
  });

  it('runs one item larger than the whole budget, alone', async () => {
    const t = setup([hostedFile(1)], { maxBytesInFlight: 8 });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
  });
});
