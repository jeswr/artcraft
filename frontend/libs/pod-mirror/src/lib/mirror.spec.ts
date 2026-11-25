import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BytesError } from './bytes.js';
import { createMemoryMirrorJournal, type MirrorJournal } from './journal.js';
import { PodMirror, type PodMirrorOptions, backoffDelay } from './mirror.js';
import {
  ACCOUNT,
  HOSTED_TOKEN_PREFIX,
  fakeBytes,
  fakeEvents,
  fakeHosted,
  fakeNetwork,
  fakeSession,
  fakeStore,
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
    const record = await t.journal.get(ACCOUNT, file.token);
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
    expect(t.mirror.stateOf(file.token)).toEqual({ kind: 'pending', attempts: 1 });
    await vi.advanceTimersByTimeAsync(5_000);
    await settle(t.mirror);
    expect(t.mirror.stateOf(file.token)).toEqual({ kind: 'pending', attempts: 2 });
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
    expect(delays[delays.length - 1]).toBeLessThanOrEqual(60_000 * 1.2);
    expect(backoffDelay(3, 1000, 60_000, () => 0)).toBeLessThan(backoffDelay(3, 1000, 60_000, () => 1));
  });

  it('fails a download that is too large for good and a missing one after the attempts run out', async () => {
    const big = hostedFile(1);
    const gone = hostedFile(2);
    const t = setup([big, gone], { maxAttempts: 3 });
    t.bytes.bodies.set(big.media_links.cdn_url, new BytesError('too-large'));
    t.bytes.bodies.delete(gone.media_links.cdn_url);
    await t.mirror.start();
    await t.mirror.enqueue(big.token);
    await t.mirror.enqueue(gone.token);
    for (let i = 0; i < 6; i++) {
      await settle(t.mirror);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    await settle(t.mirror);
    expect(t.mirror.stateOf(big.token)).toEqual({ kind: 'failed', reason: 'too-large', attempts: 1 });
    expect(t.mirror.stateOf(gone.token)).toEqual({ kind: 'failed', reason: 'bytes-unavailable', attempts: 3 });
  });

  it.each([
    ['conflict', { kind: 'conflict', reason: 'hash-mismatch' }, 'conflict'],
    ['forbidden', { kind: 'forbidden', reason: 'storage' }, 'forbidden'],
    ['too-large', { kind: 'too-large', reason: 'bytes-too-large' }, 'too-large'],
    ['unsupported', { kind: 'unsupported', reason: 'unsniffable' }, 'unsupported'],
  ] as const)('a store %s is terminal and is never retried or overwritten', async (_n, error, reason) => {
    const t = setup([hostedFile(1)]);
    t.store.putFailures.push({ ...error });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'failed', reason, attempts: 1 });
    expect(t.store.puts).toHaveLength(1);
  });

  it('retries a store outage and an unexpected store error with backoff', async () => {
    const t = setup([hostedFile(1)]);
    t.store.putFailures.push({ kind: 'offline', reason: 'storage' }, { kind: 'failed', reason: 'unexpected' });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'pending', attempts: 1 });
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(t.mirror);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
    expect(t.store.puts).toHaveLength(3);
  });

  it('retry() puts a failed item back at the front with its attempts reset', async () => {
    const t = setup([hostedFile(1)]);
    t.store.putFailures.push({ kind: 'conflict', reason: 'hash-mismatch' });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('failed');
    await t.mirror.retry(token(1));
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))?.kind).toBe('saved');
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

  it('marks the item that met an exposure refusal at write time and holds the rest', async () => {
    const t = setup([hostedFile(1), hostedFile(2)], { concurrency: 1 });
    t.store.putFailures.push({ kind: 'exposed', reason: 'library-exposed' });
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await t.mirror.enqueue(token(2));
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'failed', reason: 'exposed', attempts: 1 });
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

  it('stops at the connect watermark', async () => {
    const files = library(6); // created minutes 1..6 of 2026-06-01
    const t = setup(files, { pageSize: 2 });
    // Connect happened between item 3 and item 4.
    await t.journal.ensureWatermark(ACCOUNT, new Date(files[3].created_at).getTime() - 1);
    await t.mirror.start();
    await settle(t.mirror);
    for (const n of [6, 5, 4]) expect(t.mirror.stateOf(token(n))?.kind).toBe('saved');
    for (const n of [3, 2, 1]) expect(t.mirror.stateOf(token(n))).toBeUndefined();
  });

  it('stops at the first journalled item', async () => {
    const files = library(5);
    const t = setup(files, { pageSize: 2 });
    await t.journal.ensureWatermark(ACCOUNT, 0);
    await t.journal.create({ ...ACCOUNT, token: token(3), state: 'saved', attempts: 0, createdAt: 1, updatedAt: 1, descriptionUrl: 'https://pod.example/d3' });
    await t.mirror.start();
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(5))?.kind).toBe('saved');
    expect(t.mirror.stateOf(token(4))?.kind).toBe('saved');
    expect(t.mirror.stateOf(token(2))).toBeUndefined();
    expect(t.hosted.calls.filter((c) => c.startsWith('list:'))).toEqual(['list:0', 'list:1']);
  });

  it('walks more than one page when many items arrived since the last run', async () => {
    const t = setup(library(7), { pageSize: 3 });
    await t.journal.ensureWatermark(ACCOUNT, 0);
    await t.mirror.start();
    await settle(t.mirror);
    expect(t.mirror.summary().counts.saved).toBe(7);
    expect(t.hosted.calls.filter((c) => c.startsWith('list:'))).toEqual(['list:0', 'list:1', 'list:2']);
  });

  it('does not stop early when the hosted listing is not newest first', async () => {
    const files = library(4);
    const t = setup(files, { pageSize: 10 });
    t.hosted.listing = [files[1], files[3], files[0], files[2]];
    await t.journal.ensureWatermark(ACCOUNT, 0);
    await t.journal.create({ ...ACCOUNT, token: token(4), state: 'saved', attempts: 0, createdAt: 1, updatedAt: 1 });
    await t.mirror.start();
    await settle(t.mirror);
    const result = await t.mirror.reconcile();
    expect(result.orderUnverified).toBe(true);
    for (const n of [1, 2, 3]) expect(t.mirror.stateOf(token(n))?.kind).toBe('saved');
  });

  it('reports a hosted outage and tries again on the next call', async () => {
    const t = setup(library(2));
    await t.journal.ensureWatermark(ACCOUNT, 0);
    t.hosted.listDown = true;
    await t.mirror.start();
    await settle(t.mirror);
    expect((await t.mirror.reconcile()).stoppedBy).toBe('hosted-unavailable');
    t.hosted.listDown = false;
    const result = await t.mirror.reconcile();
    await settle(t.mirror);
    expect(result.enqueued).toBe(2);
  });

  it('journals what it skips so the gallery can say why', async () => {
    const files = [hostedFile(1), hostedFile(2, { media_type: 'audio', media_class: 'audio' })];
    const t = setup(files);
    await t.journal.ensureWatermark(ACCOUNT, 0);
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
    await t.journal.ensureWatermark(ACCOUNT, 0);
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
    expect(await t.journal.get(ACCOUNT, token(1))).toBeUndefined();
  });

  it('keeps a failed half visible, retries it, and finishes', async () => {
    const t = setup([hostedFile(1)], { maxAttempts: 2 });
    await t.mirror.start();
    await saved(t);
    t.store.removeFailures.push({ kind: 'forbidden', reason: 'storage' });
    t.events.emit({ type: 'deleted', token: token(1) });
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toEqual({ kind: 'remove-failed', reason: 'forbidden', attempts: 1 });
    expect(t.mirror.summary().counts.failed).toBe(1);
    await t.mirror.retry(token(1));
    await settle(t.mirror);
    expect(t.mirror.stateOf(token(1))).toBeUndefined();
    expect(t.store.removed).toHaveLength(1);
  });

  it('resumes a removal that a crash interrupted', async () => {
    const journal = createMemoryMirrorJournal();
    await journal.ensureWatermark(ACCOUNT, 0);
    await journal.create({ ...ACCOUNT, token: token(1), state: 'removing', attempts: 0, createdAt: 1, updatedAt: 1, descriptionUrl: 'https://pod.example/alice/creative-assets/2026/06/descX' });
    const t = setup([], {}, journal);
    await t.mirror.start();
    await settle(t.mirror);
    expect(t.store.removed).toEqual(['https://pod.example/alice/creative-assets/2026/06/descX']);
    expect(t.store.resumed).toBe(1);
    expect(await journal.get(ACCOUNT, token(1))).toBeUndefined();
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
    await journal.ensureWatermark(ACCOUNT, 0);
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
    expect(await t.journal.list(ACCOUNT)).toEqual([]);
    expect(t.mirror.summary().counts.saved).toBe(0);
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    expect(await t.journal.list(ACCOUNT)).toEqual([]);
  });

  it('a stopped mirror keeps its journal and notifies subscribers of changes', async () => {
    const t = setup([hostedFile(1)]);
    const seen: number[] = [];
    t.mirror.subscribe(() => seen.push(t.mirror.summary().version));
    await t.mirror.start();
    await t.mirror.enqueue(token(1));
    await settle(t.mirror);
    await t.mirror.stop();
    expect(await t.journal.get(ACCOUNT, token(1))).toMatchObject({ state: 'saved' });
    expect(new Set(seen).size).toBeGreaterThan(2);
    expect(t.mirror.summary().paused).toBe('stopped');
  });
});
