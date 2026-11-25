import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BytesError } from './bytes.js';
import { createMemoryMirrorJournal, type MirrorJournal } from './journal.js';
import { journalAccount, PodMirror, type PodMirrorOptions } from './mirror.js';
import {
  ACCOUNT,
  JOURNAL_ACCOUNT,
  fakeBytes,
  fakeEvents,
  fakeHosted,
  fakeNetwork,
  fakeSession,
  fakeStore,
  hostedFile,
  openFake,
} from './testing.js';
import type { HostedMediaFile } from './types.js';

const OTHER = { webId: 'https://pod.example/bob/profile/card#me', username: 'bob_hosted' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-10T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

const library = (count: number, from = 1) => Array.from({ length: count }, (_, i) => hostedFile(from + i));

function setup(files: HostedMediaFile[], overrides: Partial<PodMirrorOptions> = {}, journal: MirrorJournal = createMemoryMirrorJournal(), account = ACCOUNT) {
  const hosted = fakeHosted(files);
  hosted.user = account.username;
  const store = fakeStore();
  const bytes = fakeBytes(hosted);
  const session = fakeSession();
  const network = fakeNetwork();
  const mirror = new PodMirror({
    account,
    journal,
    hosted,
    openStore: openFake(store),
    fetchPublicBytes: bytes.fetch,
    session,
    network,
    events: fakeEvents(),
    random: () => 0.5,
    pageSize: 10,
    ...overrides,
  });
  return { hosted, store, bytes, session, network, mirror, journal };
}

/** Lets the walk, the queue and the timers run until nothing more happens by itself. */
const drain = async (mirror: PodMirror, rounds = 40) => {
  for (let i = 0; i < rounds; i++) {
    await vi.advanceTimersByTimeAsync(0);
    await mirror.idle();
  }
};

/** Like `drain`, but does not wait for puts that are held. */
const tick = async (rounds = 40) => {
  for (let i = 0; i < rounds; i++) await vi.advanceTimersByTimeAsync(0);
};

const holdPuts = (store: ReturnType<typeof fakeStore>) => {
  let release: () => void = () => undefined;
  store.gate = new Promise<void>((resolve) => (release = resolve));
  return () => {
    store.gate = null;
    release();
  };
};

const listCalls = (hosted: ReturnType<typeof fakeHosted>) => hosted.calls.filter((c) => c.startsWith('list:')).length;

describe('copy my existing library', () => {
  it('walks every page, past the connect baseline, and gives every hosted item a journal state', async () => {
    const t = setup(library(45));
    await t.mirror.start();
    await drain(t.mirror);
    // Connecting copied nothing: everything already there is older than the baseline.
    expect(t.store.puts).toHaveLength(0);
    const { total } = await t.mirror.estimateImport();
    expect(total).toBe(45);

    expect(await t.mirror.startImport(total)).toBe(true);
    await drain(t.mirror);
    const status = t.mirror.summary().import;
    expect(status).toMatchObject({ state: 'done', saved: 45, failed: 0, pending: 0, walked: 45, total: 45 });
    expect(status.finishedAt).not.toBeNull();
    expect(t.store.puts).toHaveLength(45);
    for (const file of t.hosted.files.values()) expect(t.mirror.stateOf(file.token)?.kind).toBe('saved');
  });

  it('pauses without losing its place, and resumes from it', async () => {
    const t = setup(library(40));
    await t.mirror.start();
    await drain(t.mirror);
    const release = holdPuts(t.store);
    await t.mirror.startImport();
    await tick();
    await t.mirror.pauseImport();
    const listedWhenPaused = listCalls(t.hosted);
    release();
    await drain(t.mirror);
    expect(t.mirror.summary().import.state).toBe('paused');
    expect(listCalls(t.hosted)).toBe(listedWhenPaused);
    expect(t.store.puts.length).toBeLessThan(40);

    expect(await t.mirror.resumeImport()).toBe(true);
    await drain(t.mirror);
    expect(t.mirror.summary().import).toMatchObject({ state: 'done', saved: 40 });
    expect(t.store.puts).toHaveLength(40);
  });

  it('pauses when the engine does: the session drops, then comes back', async () => {
    const t = setup(library(30));
    await t.mirror.start();
    await drain(t.mirror);
    const release = holdPuts(t.store);
    await t.mirror.startImport();
    await tick();
    t.session.set(false);
    release();
    await drain(t.mirror);
    const stalled = listCalls(t.hosted);
    await vi.advanceTimersByTimeAsync(60_000);
    await drain(t.mirror);
    expect(listCalls(t.hosted)).toBe(stalled);
    expect(t.mirror.summary().import.state).toBe('running');
    expect(t.mirror.summary().paused).toBe('session');

    t.session.set(true);
    await drain(t.mirror);
    expect(t.mirror.summary().import.state).toBe('done');
    expect(t.store.puts).toHaveLength(30);
  });

  it('cancel leaves copied items in place, and a later run finishes without copying anything twice', async () => {
    const t = setup(library(40));
    await t.mirror.start();
    await drain(t.mirror);
    const release = holdPuts(t.store);
    await t.mirror.startImport();
    await tick();
    await t.mirror.cancelImport();
    release();
    await drain(t.mirror);
    expect(t.mirror.summary().import.state).toBe('cancelled');
    const copied = t.store.puts.length;
    expect(copied).toBeGreaterThan(0);
    expect(copied).toBeLessThan(40);
    expect(t.mirror.summary().counts.saved).toBe(copied);

    await t.mirror.startImport();
    await drain(t.mirror);
    expect(t.mirror.summary().import.state).toBe('done');
    expect(t.mirror.summary().counts.saved).toBe(40);
    expect(t.store.puts).toHaveLength(40);
  });

  it('does not copy again what live mirroring already saved', async () => {
    const t = setup(library(20));
    await t.mirror.start();
    await drain(t.mirror);
    for (const n of [20, 19, 18]) await t.mirror.enqueue(`m_secrettoken${n}`);
    await drain(t.mirror);
    expect(t.store.puts).toHaveLength(3);
    await t.mirror.startImport();
    await drain(t.mirror);
    expect(t.store.puts).toHaveLength(20);
    expect(new Set(t.store.puts.map((p) => JSON.stringify((p as { description: unknown }).description))).size).toBe(20);
  });

  it('goes on after a restart if it was running, and never starts by itself otherwise', async () => {
    const journal = createMemoryMirrorJournal();
    const first = setup(library(40), {}, journal);
    await first.mirror.start();
    await drain(first.mirror);
    const release = holdPuts(first.store);
    await first.mirror.startImport();
    await tick();
    const stop = first.mirror.stop();
    release();
    await stop;

    const second = setup(library(40), {}, journal);
    await second.mirror.start();
    await drain(second.mirror);
    expect(second.mirror.summary().import.state).toBe('done');
    expect(second.mirror.summary().counts.saved).toBe(40);

    // A cancelled run does not start again by itself either.
    const cancelling = setup(library(40), {}, createMemoryMirrorJournal());
    await cancelling.mirror.start();
    await drain(cancelling.mirror);
    await cancelling.mirror.startImport();
    await cancelling.mirror.cancelImport();
    await cancelling.mirror.stop();
    const after = setup(library(40), {}, cancelling.journal);
    await after.mirror.start();
    await drain(after.mirror);
    expect(after.mirror.summary().import.state).toBe('cancelled');
    const idle = setup(library(10), {}, createMemoryMirrorJournal());
    await idle.mirror.start();
    await drain(idle.mirror);
    expect(idle.mirror.summary().import.state).toBe('idle');
    expect(idle.hosted.calls.filter((c) => c === 'list:1')).toHaveLength(0);
  });

  it('takes a live item before the import items that are still waiting', async () => {
    const t = setup(library(40));
    await t.mirror.start();
    await drain(t.mirror);
    const release = holdPuts(t.store);
    await t.mirror.startImport();
    await tick();
    const live = hostedFile(500, { maybe_title: 'live item' });
    t.hosted.files.set(live.token, live);
    t.bytes.bodies.set(live.media_links.cdn_url, t.bytes.bodies.get('https://cdn.example/files/1.png')!);
    await t.mirror.enqueue(live.token);
    release();
    await drain(t.mirror);
    const order = t.store.puts.map((p) => (p as { description: { name?: string } }).description.name);
    // Two import items were already in flight; the live one is the very next to go.
    expect(order.indexOf('live item')).toBe(2);
    expect(t.store.puts).toHaveLength(41);
  });

  it('pauses with the no-space message only when the pod says its storage is full, and keeps the item waiting', async () => {
    const t = setup(library(30));
    await t.mirror.start();
    await drain(t.mirror);
    t.store.putFailures.push({ kind: 'too-large', reason: 'insufficient-storage' });
    await t.mirror.startImport();
    await drain(t.mirror);
    const status = t.mirror.summary().import;
    expect(status).toMatchObject({ state: 'paused', pausedBy: 'quota', failed: 0 });
    expect(status.walked).toBeLessThan(30);
    expect(t.mirror.summary().counts.failed).toBe(0);

    await t.mirror.resumeImport();
    await vi.advanceTimersByTimeAsync(60_000);
    await drain(t.mirror);
    expect(t.mirror.summary().import).toMatchObject({ state: 'done', saved: 30, pausedBy: null });
  });

  it('skips one item the pod says is too big for a single request, and goes on without pausing or downloading it again', async () => {
    const t = setup(library(20));
    await t.mirror.start();
    await drain(t.mirror);
    const big = hostedFile(7).media_links.cdn_url;
    const original = t.store.put.bind(t.store);
    t.store.put = async (input) =>
      input.createdAt.getUTCMinutes() === 7 ? { ok: false, error: { kind: 'too-large', reason: 'payload-too-large' } } : original(input);
    await t.mirror.startImport();
    await drain(t.mirror);
    await vi.advanceTimersByTimeAsync(24 * 3_600_000);
    await drain(t.mirror);
    expect(t.mirror.summary().import).toMatchObject({ state: 'done', saved: 19, skipped: 1, failed: 0 });
    expect(t.mirror.stateOf(`m_secrettoken7`)).toEqual({ kind: 'skipped', reason: 'too-large-for-pod' });
    expect(t.bytes.urls.filter((u) => u === big)).toHaveLength(1);
  });

  it('cannot tell a 413 from a 507 on the current store: one item is skipped, a second different one means the pod is full', async () => {
    const t = setup(library(20));
    await t.mirror.start();
    await drain(t.mirror);
    t.store.putFailures.push({ kind: 'too-large', reason: 'storage' });
    await t.mirror.startImport();
    await drain(t.mirror);
    expect(t.mirror.summary().import.state).toBe('done');
    expect(t.mirror.summary().counts.skipped).toBe(1);

    const full = setup(library(20));
    await full.mirror.start();
    await drain(full.mirror);
    full.store.putFailures.push({ kind: 'too-large', reason: 'storage' }, { kind: 'too-large', reason: 'storage' });
    await full.mirror.startImport();
    await drain(full.mirror);
    expect(full.mirror.summary().import).toMatchObject({ state: 'paused', pausedBy: 'quota' });
  });

  it('keeps one account\'s run apart from another account\'s', async () => {
    const journal = createMemoryMirrorJournal();
    const alice = setup(library(20), {}, journal);
    const bob = setup(library(20, 100), {}, journal, OTHER);
    await alice.mirror.start();
    await bob.mirror.start();
    await drain(alice.mirror);
    await drain(bob.mirror);
    await alice.mirror.startImport();
    await drain(alice.mirror);
    await drain(bob.mirror);
    expect(alice.mirror.summary().import).toMatchObject({ state: 'done', saved: 20 });
    expect(bob.mirror.summary().import).toMatchObject({ state: 'idle', saved: 0, walked: 0 });
    expect(bob.store.puts).toHaveLength(0);
    expect((await journal.list(journalAccount(OTHER, 'https://api.example'))).length).toBe(0);

    await alice.mirror.forgetAccount();
    expect(alice.mirror.summary().import.state).toBe('idle');
    expect((await journal.getAccountState(JOURNAL_ACCOUNT))?.import).toBeUndefined();
  });

  it('reuses retry all failed for what the run could not copy', async () => {
    const t = setup(library(10));
    await t.mirror.start();
    await drain(t.mirror);
    let failing = true;
    const original = t.store.put.bind(t.store);
    t.store.put = async (input) =>
      failing && input.createdAt.getUTCMinutes() === 1 ? { ok: false, error: { kind: 'conflict', reason: 'hash-mismatch' } } : original(input);
    await t.mirror.startImport();
    for (let i = 0; i < 6; i++) {
      await drain(t.mirror);
      await vi.advanceTimersByTimeAsync(60_000);
    }
    expect(t.mirror.summary().import).toMatchObject({ state: 'done', failed: 1, saved: 9 });
    failing = false;
    expect(await t.mirror.retryAllFailed()).toBe(1);
    await drain(t.mirror);
    expect(t.mirror.summary().import).toMatchObject({ failed: 0, saved: 10 });
  });

  it('cancel keeps a new item the import happened to admit as live work', async () => {
    const t = setup(library(30));
    await t.mirror.start();
    await drain(t.mirror);
    // Two new items arrive; the import reaches them before any live walk does.
    for (const n of [31, 32]) {
      const file = hostedFile(n);
      t.hosted.files.set(file.token, file);
      t.hosted.listing.unshift(file);
      t.bytes.bodies.set(file.media_links.cdn_url, t.bytes.bodies.get('https://cdn.example/files/1.png')!);
    }
    const release = holdPuts(t.store);
    await t.mirror.startImport();
    await tick();
    expect(t.mirror.stateOf('m_secrettoken31')?.kind).toBe('pending');
    await t.mirror.cancelImport();
    release();
    await drain(t.mirror);
    expect(t.mirror.stateOf('m_secrettoken31')?.kind).toBe('saved');
    expect(t.mirror.stateOf('m_secrettoken32')?.kind).toBe('saved');
    expect(t.mirror.summary().import.state).toBe('cancelled');
  });

  it('cancel keeps a live item that is waiting to be retried, though nothing of it is in flight', async () => {
    const t = setup(library(30));
    await t.mirror.start();
    await drain(t.mirror);
    const file = hostedFile(31);
    t.hosted.files.set(file.token, file);
    t.hosted.listing.unshift(file);
    t.bytes.bodies.set(file.media_links.cdn_url, new BytesError('unavailable'));
    // An old item the import cannot fetch either, so the run is still going when it is cancelled.
    const old = hostedFile(3);
    t.bytes.bodies.set(old.media_links.cdn_url, new BytesError('unavailable'));
    await t.mirror.startImport();
    await drain(t.mirror);
    expect(t.mirror.summary().import.state).toBe('running');
    expect(t.mirror.stateOf(file.token)).toMatchObject({ kind: 'pending' });
    expect(t.mirror.stateOf(old.token)).toMatchObject({ kind: 'pending' });
    await t.mirror.cancelImport();
    await tick();
    expect(t.mirror.stateOf(file.token)).toMatchObject({ kind: 'pending' });
    expect(t.mirror.stateOf(old.token)).toBeUndefined();
  });

  it('stops going over the listing once a catch-up pass finds nothing new', async () => {
    const t = setup(library(30));
    await t.mirror.start();
    await drain(t.mirror);
    const before = listCalls(t.hosted);
    await t.mirror.startImport();
    await drain(t.mirror);
    expect(t.mirror.summary().import.state).toBe('done');
    // Three pages a pass: the first pass, then one catch-up pass that finds nothing, then done.
    expect(listCalls(t.hosted) - before).toBe(6);
  });

  it('does not report finished while copies are still waiting, and keeps pause and cancel until then', async () => {
    const t = setup(library(15));
    await t.mirror.start();
    await drain(t.mirror);
    const release = holdPuts(t.store);
    await t.mirror.startImport();
    await tick();
    await tick();
    const status = t.mirror.summary().import;
    expect(status.state).toBe('running');
    expect(status.pending).toBeGreaterThan(0);
    await t.mirror.pauseImport();
    expect(t.mirror.summary().import.state).toBe('paused');
    await t.mirror.resumeImport();
    release();
    await drain(t.mirror);
    expect(t.mirror.summary().import).toMatchObject({ state: 'done', pending: 0, saved: 15 });
  });

  it('is not held up by a page of items that keep failing, and is not done while they are still pending', async () => {
    const t = setup(library(40));
    await t.mirror.start();
    await drain(t.mirror);
    const good = t.bytes.bodies.get(hostedFile(1).media_links.cdn_url)!;
    const failing = [40, 39, 38, 37, 36, 35, 34, 33, 32, 31];
    for (const n of failing) t.bytes.bodies.set(hostedFile(n).media_links.cdn_url, new BytesError('unavailable'));
    await t.mirror.startImport();
    await drain(t.mirror);
    const status = t.mirror.summary().import;
    expect(status.walked).toBe(40); // the walk went past the page that cannot be copied
    expect(status.saved).toBe(30);
    expect(status.state).toBe('running');
    expect(status.pending).toBe(10);
    for (const n of failing) t.bytes.bodies.set(hostedFile(n).media_links.cdn_url, good);
    await vi.advanceTimersByTimeAsync(20 * 60_000);
    await drain(t.mirror);
    expect(t.mirror.summary().import).toMatchObject({ state: 'done', saved: 40 });
  });

  it('goes over the listing again, so an item that slid past the walk is not missed', async () => {
    const t = setup(library(40));
    await t.mirror.start();
    await drain(t.mirror);
    const list = t.hosted.listUserMediaFiles.bind(t.hosted);
    let deleted = false;
    t.hosted.listUserMediaFiles = async (page, size, signal) => {
      const got = await list(page, size, signal);
      if (page === 1 && !deleted) {
        deleted = true;
        t.hosted.files.delete('m_secrettoken40');
        t.hosted.listing = t.hosted.listing.filter((f) => f.token !== 'm_secrettoken40');
      }
      return got;
    };
    await t.mirror.startImport();
    await drain(t.mirror);
    expect(t.mirror.summary().import.state).toBe('done');
    for (const f of t.hosted.listing) expect(t.mirror.stateOf(f.token)?.kind, f.token).toBe('saved');
  });

  it('does not resume a paused run on restart', async () => {
    const journal = createMemoryMirrorJournal();
    const first = setup(library(30), {}, journal);
    await first.mirror.start();
    await drain(first.mirror);
    const release = holdPuts(first.store);
    await first.mirror.startImport();
    await tick();
    await first.mirror.pauseImport();
    const stop = first.mirror.stop();
    release();
    await stop;

    const second = setup(library(30), {}, journal);
    await second.mirror.start();
    await drain(second.mirror);
    await vi.advanceTimersByTimeAsync(3_600_000);
    await drain(second.mirror);
    expect(second.mirror.summary().import.state).toBe('paused');
    expect(second.hosted.calls.filter((c) => c.startsWith('list:') && c !== 'list:0')).toEqual([]);
  });

  it('resumes a run one page back from where it was saved', async () => {
    const journal = createMemoryMirrorJournal();
    const newest = hostedFile(30);
    await journal.ensureBaseline(JOURNAL_ACCOUNT, { kind: 'item', token: newest.token, createdAt: new Date(newest.created_at).getTime() });
    await journal.updateAccountState(JOURNAL_ACCOUNT, { import: { state: 'running', walked: 20, total: 30, cursor: { page: 2 }, startedAt: 1 } });
    const t = setup(library(30), {}, journal);
    await t.mirror.start();
    await drain(t.mirror);
    // With the baseline already stored, the only listing calls are the import's: the first is the page before the cursor.
    expect(t.hosted.calls.filter((c) => c.startsWith('list:'))[0]).toBe('list:1');
  });

  it('saves its place after every page, so a crash does not lose it', async () => {
    const t = setup(library(40));
    await t.mirror.start();
    await drain(t.mirror);
    holdPuts(t.store);
    await t.mirror.startImport();
    await tick();
    expect((await t.journal.getAccountState(JOURNAL_ACCOUNT))?.import?.cursor?.page).toBeGreaterThanOrEqual(1);
  });

  it('does not read the listing while the pod is paused for exposure', async () => {
    const t = setup(library(30));
    t.store.exposure = 'exposed';
    await t.mirror.start();
    await drain(t.mirror);
    const before = listCalls(t.hosted);
    await t.mirror.startImport();
    await tick();
    expect(t.mirror.summary().paused).toBe('exposed');
    expect(listCalls(t.hosted)).toBe(before);
  });

  it('does not hand a journalled item to the journal again', async () => {
    const journal = createMemoryMirrorJournal();
    const created: string[] = [];
    const original = journal.create.bind(journal);
    journal.create = async (record) => {
      created.push(record.token);
      return original(record);
    };
    const t = setup(library(20), {}, journal);
    await t.mirror.start();
    await drain(t.mirror);
    for (const n of [20, 19, 18]) await t.mirror.enqueue(`m_secrettoken${n}`);
    await drain(t.mirror);
    created.length = 0;
    await t.mirror.startImport();
    await drain(t.mirror);
    expect(created).not.toContain('m_secrettoken18');
    expect(created).not.toContain('m_secrettoken19');
    expect(created).not.toContain('m_secrettoken20');
  });
});
