import type { DeleteJournal } from '@jeswr/pod-media-store';
import { createTypeIndex } from '@jeswr/pod-type-index';
import { StorageError } from '@jeswr/storage-client';
import { createMemoryStorage } from '@jeswr/storage-client/memory';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { asPodStorePort, openCreativeAssetStore } from './assets-store.js';
import { createMemoryMirrorJournal } from './journal.js';
import { PodMirror } from './mirror.js';
import { ACCOUNT, fakeBytes, fakeEvents, fakeHosted, fakeNetwork, fakeSession, hostedFile, png } from './testing.js';

/**
 * The real media store over an in-memory pod, with deletes that can be made to fail. Two hosted
 * items hold the same bytes (token 2 is token 1's image), so they share one pod copy.
 */
const ROOT = 'https://pod.example/alice/';
const WEB_ID = `${ROOT}profile/card#me`;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-10T00:00:00Z'));
});
afterEach(() => vi.useRealTimers());

const settle = async (mirror: PodMirror) => {
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(0);
    await mirror.idle();
  }
};
const spin = async () => {
  for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(0);
};

async function world() {
  const storage = createMemoryStorage({ protocol: 'solid', root: ROOT });
  await storage.write(`${ROOT}profile/card`, `<${WEB_ID}> a <http://xmlns.com/foaf/0.1/Person>.`, { contentType: 'text/turtle', ifMatch: '*' });
  const journal = createMemoryMirrorJournal();
  const hosted = fakeHosted([hostedFile(1), hostedFile(2)]);
  const bytes = fakeBytes(hosted);
  bytes.bodies.set(hostedFile(2).media_links.cdn_url, png(1));
  // What the next DELETEs do: 'pass', or fail the n-th with a network error; `hold` parks the first.
  const plan: { failFrom: number | null; deletes: number; hold: Promise<void> | null; deleteJournal: ((real: DeleteJournal) => DeleteJournal) | null } = {
    failFrom: null,
    deletes: 0,
    hold: null,
    deleteJournal: null,
  };
  const flaky = new Proxy(storage, {
    get(target, prop, receiver) {
      if (prop !== 'delete') return Reflect.get(target, prop, receiver);
      return async (url: string, options: unknown) => {
        const real = () => (target as unknown as { delete: (u: string, o: unknown) => Promise<unknown> }).delete(url, options);
        plan.deletes++;
        if (plan.hold && plan.deletes === 1) await plan.hold;
        if (plan.failFrom !== null && plan.deletes >= plan.failFrom) throw new StorageError('network', { url, method: 'DELETE' });
        return real();
      };
    },
  });
  const open = (events = fakeEvents()) => {
    const mirror = new PodMirror({
      account: ACCOUNT,
      journal,
      hosted,
      fetchPublicBytes: bytes.fetch,
      session: fakeSession(),
      network: fakeNetwork(),
      events,
      random: () => 0.5,
      openStore: async (signal, options) => {
        const deletes = plan.deleteJournal ? plan.deleteJournal(journal.deletesFor(WEB_ID, ROOT)) : journal.deletesFor(WEB_ID, ROOT);
        const store = await openCreativeAssetStore({
          storage: flaky as never,
          features: storage.features,
          typeIndex: createTypeIndex({ storage: flaky as never, features: storage.features, profile: WEB_ID }),
          exposure: async () => 'private',
          journal: deletes,
          allowUnknownExposureFor: options.allowUnknownExposureFor,
          signal,
        });
        return store.ok ? { ok: true, store: asPodStorePort(store.value, ROOT) } : { ok: false, reason: 'failed' };
      },
    });
    return { mirror, events };
  };
  // The binary a description names (the half-finished delete the tests stage names it).
  const binaryOf = async (url: string) => {
    const shard = url.slice(0, url.lastIndexOf('/') + 1);
    for await (const entry of storage.listAll(shard)) if (entry.url !== url && entry.url.startsWith(`${url}.`) && !entry.url.includes('-thumb')) return entry.url;
    return undefined;
  };
  const exists = (url: string) => storage.head(url).then(() => true, () => false);
  return { storage, journal, hosted, plan, open, exists, binaryOf, deletes: () => journal.deletesFor(WEB_ID, ROOT).list() };
}

const urlOf = (mirror: PodMirror, n: number) => (mirror.stateOf(hostedFile(n).token) as { descriptionUrl: string }).descriptionUrl;

describe('a delete the store has pending for a copy that another record now pairs with', () => {
  it('is not carried out by the next start (an interrupted delete, then the same bytes under another token)', async () => {
    const w = await world();
    const a = w.open();
    await a.mirror.start();
    await a.mirror.enqueue(hostedFile(1).token);
    await settle(a.mirror);
    const url = urlOf(a.mirror, 1);

    // The person deletes item 1; the pod's DELETE fails with a network error: the intent stays journalled.
    w.plan.failFrom = 1;
    w.hosted.files.delete(hostedFile(1).token);
    a.events.emit({ type: 'deleted', token: hostedFile(1).token });
    await settle(a.mirror);
    expect((await w.deletes()).map((e) => e.descriptionUrl)).toEqual([url]);

    // The same bytes arrive as item 2 and adopt the copy while the removal waits out its backoff.
    w.plan.failFrom = null;
    await a.mirror.enqueue(hostedFile(2).token);
    await settle(a.mirror);
    expect(a.mirror.stateOf(hostedFile(2).token)).toMatchObject({ kind: 'saved', descriptionUrl: url });
    // The pairing withdrew the pending delete.
    expect(await w.deletes()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(a.mirror);
    expect(a.mirror.stateOf(hostedFile(1).token)).toBeUndefined();
    await a.mirror.stop();

    const b = w.open();
    await b.mirror.start();
    await settle(b.mirror);
    expect(await w.exists(url)).toBe(true);
    expect(b.mirror.stateOf(hostedFile(2).token)).toMatchObject({ kind: 'saved', descriptionUrl: url });
  });

  it('is never listed to the store while a record of any account pairs with the copy, even if nothing withdrew it', async () => {
    const w = await world();
    const a = w.open();
    await a.mirror.start();
    await a.mirror.enqueue(hostedFile(1).token);
    await settle(a.mirror);
    const url = urlOf(a.mirror, 1);
    w.plan.failFrom = 1;
    w.hosted.files.delete(hostedFile(1).token);
    a.events.emit({ type: 'deleted', token: hostedFile(1).token });
    await settle(a.mirror);
    await a.mirror.stop();
    expect((await w.deletes()).map((e) => e.descriptionUrl)).toEqual([url]);
    // Another hosted account on this pod pairs with the copy (recorded by a mirror that is not running now).
    w.plan.failFrom = null;
    await w.journal.create({ webId: WEB_ID, username: 'bob_hosted|https://api.example', token: 'm_bob', state: 'saved', attempts: 0, createdAt: 1, updatedAt: 1, descriptionUrl: url });
    const b = w.open();
    await b.mirror.start();
    await settle(b.mirror);
    expect(await w.exists(url)).toBe(true);
  });

  it('is carried out once nothing pairs with the copy any more', async () => {
    const w = await world();
    const a = w.open();
    await a.mirror.start();
    await a.mirror.enqueue(hostedFile(1).token);
    await settle(a.mirror);
    const url = urlOf(a.mirror, 1);
    w.plan.failFrom = 1;
    w.hosted.files.delete(hostedFile(1).token);
    a.events.emit({ type: 'deleted', token: hostedFile(1).token });
    await settle(a.mirror);
    await a.mirror.stop();
    w.plan.failFrom = null;
    const b = w.open();
    await b.mirror.start();
    await settle(b.mirror);
    expect(await w.exists(url)).toBe(false);
  });
});

describe('a delete that fails after it removed the description', () => {
  it('makes a put that adopted the copy meanwhile repeat, so the item is not saved on a dead link, and nothing finishes the delete', async () => {
    const w = await world();
    const a = w.open();
    await a.mirror.start();
    await a.mirror.enqueue(hostedFile(1).token);
    await settle(a.mirror);
    const url = urlOf(a.mirror, 1);

    // The delete removes the description (slowly), then the binary DELETE fails.
    let openGate: () => void = () => undefined;
    w.plan.hold = new Promise<void>((resolve) => (openGate = resolve));
    w.plan.deletes = 0;
    w.plan.failFrom = 2;
    w.hosted.files.delete(hostedFile(1).token);
    a.events.emit({ type: 'deleted', token: hostedFile(1).token });
    await spin();
    await a.mirror.enqueue(hostedFile(2).token); // same bytes: adopts the copy, then waits for the lock
    await spin();
    w.plan.failFrom = 2;
    openGate();
    await settle(a.mirror);
    w.plan.failFrom = null;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(a.mirror);

    expect(a.mirror.stateOf(hostedFile(2).token)).toMatchObject({ kind: 'saved', descriptionUrl: url });
    expect(await w.exists(url)).toBe(true);
    await a.mirror.stop();
    const b = w.open();
    await b.mirror.start();
    await settle(b.mirror);
    expect(await w.exists(url)).toBe(true);
    expect(b.mirror.stateOf(hostedFile(2).token)).toMatchObject({ kind: 'saved' });
  });
});

describe('the veto the mirror gives the store for a pending delete', () => {
  const interrupted = async (w: Awaited<ReturnType<typeof world>>) => {
    const a = w.open();
    await a.mirror.start();
    await a.mirror.enqueue(hostedFile(1).token);
    await settle(a.mirror);
    const url = urlOf(a.mirror, 1);
    w.plan.failFrom = 1;
    w.hosted.files.delete(hostedFile(1).token);
    a.events.emit({ type: 'deleted', token: hostedFile(1).token });
    await settle(a.mirror);
    await a.mirror.stop();
    w.plan.failFrom = null;
    return url;
  };

  it('withdraws the journalled delete of a copy that a record pairs with, so a later start without any veto cannot finish it either', async () => {
    const w = await world();
    const url = await interrupted(w);
    await w.journal.create({ webId: WEB_ID, username: 'bob_hosted|https://api.example', token: 'm_bob', state: 'saved', attempts: 0, createdAt: 1, updatedAt: 1, descriptionUrl: url });
    const b = w.open();
    await b.mirror.start();
    await settle(b.mirror);
    expect(await w.exists(url)).toBe(true);
    expect(await w.deletes()).toEqual([]);
  });

  it('keeps the delete and the copy when the journal cannot say what pairs with it (a skipped entry), and finishes it on a later start', async () => {
    const w = await world();
    const url = await interrupted(w);
    const spy = vi.spyOn(w.journal, 'isPairedElsewhere').mockRejectedValue(new Error('closed'));
    const b = w.open();
    await b.mirror.start();
    await settle(b.mirror);
    expect(await w.exists(url)).toBe(true);
    expect((await w.deletes()).map((e) => e.descriptionUrl)).toEqual([url]);
    await b.mirror.stop();
    spy.mockRestore();
    const c = w.open();
    await c.mirror.start();
    await settle(c.mirror);
    expect(await w.exists(url)).toBe(false);
    expect(await w.deletes()).toEqual([]);
  });

  it('copies again a record whose copy an earlier delete had already taken the description of', async () => {
    const w = await world();
    const a = w.open();
    await a.mirror.start();
    await a.mirror.enqueue(hostedFile(1).token);
    await settle(a.mirror);
    const url = urlOf(a.mirror, 1);
    await a.mirror.stop();
    // Another window began a delete of this copy and took the description, then died (phase `deleted`).
    await w.storage.delete(url, { ifMatch: (await w.storage.read(url)).etag as string });
    await w.journal.deletesFor(WEB_ID, ROOT).put({ descriptionUrl: url, shardUrl: url.slice(0, url.lastIndexOf('/') + 1), phase: 'deleted', binaryUrl: await w.binaryOf(url) });
    const b = w.open();
    await b.mirror.start();
    await settle(b.mirror);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(b.mirror);
    expect(await w.exists(url)).toBe(true);
    expect(b.mirror.stateOf(hostedFile(1).token)).toMatchObject({ kind: 'saved', descriptionUrl: url });
    expect(await w.deletes()).toEqual([]);
  });
});

describe('a shared copy whose description an earlier delete already took', () => {
  it('is copied again for the record that still pairs with it when the other record is removed (withdrawPending says incomplete)', async () => {
    const w = await world();
    const a = w.open();
    await a.mirror.start();
    await a.mirror.enqueue(hostedFile(1).token);
    await a.mirror.enqueue(hostedFile(2).token);
    await settle(a.mirror);
    const url = urlOf(a.mirror, 1);
    expect(urlOf(a.mirror, 2)).toBe(url);
    // A half-finished delete of this copy (from another window): description gone, intent journalled.
    await w.storage.delete(url, { ifMatch: (await w.storage.read(url)).etag as string });
    await w.journal.deletesFor(WEB_ID, ROOT).put({ descriptionUrl: url, shardUrl: url.slice(0, url.lastIndexOf('/') + 1), phase: 'deleted', binaryUrl: await w.binaryOf(url) });
    w.hosted.files.delete(hostedFile(1).token);
    a.events.emit({ type: 'deleted', token: hostedFile(1).token });
    await settle(a.mirror);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(a.mirror);
    expect(a.mirror.stateOf(hostedFile(1).token)).toBeUndefined();
    expect(a.mirror.stateOf(hostedFile(2).token)).toMatchObject({ kind: 'saved', descriptionUrl: url });
    expect(await w.exists(url)).toBe(true);
    expect(await w.deletes()).toEqual([]);
  });
});

describe('a put that adopts a copy while the store cannot reach its delete journal', () => {
  it('is not recorded saved (failed / journal is transient), and succeeds once the journal answers, withdrawing the pending delete', async () => {
    const w = await world();
    const a = w.open();
    await a.mirror.start();
    await a.mirror.enqueue(hostedFile(1).token);
    await settle(a.mirror);
    const url = urlOf(a.mirror, 1);
    w.plan.failFrom = 1;
    w.hosted.files.delete(hostedFile(1).token);
    a.events.emit({ type: 'deleted', token: hostedFile(1).token });
    await settle(a.mirror);
    await a.mirror.stop();
    w.plan.failFrom = null;
    // This start cannot tell what pairs with the copy: the veto says no, the delete stays pending, the copy stays.
    const spy = vi.spyOn(w.journal, 'isPairedElsewhere').mockRejectedValue(new Error('closed'));
    let down = true;
    w.plan.deleteJournal = (real) => ({
      put: (entry) => real.put(entry),
      list: () => real.list(),
      delete: (u) => (down ? Promise.reject(new Error('journal down')) : real.delete(u)),
    });
    const b = w.open();
    await b.mirror.start();
    await settle(b.mirror);
    spy.mockRestore();
    expect(await w.exists(url)).toBe(true);
    expect(await w.deletes()).toHaveLength(1);

    await b.mirror.enqueue(hostedFile(2).token);
    await settle(b.mirror);
    // Adopting the copy would have left its pending delete in force: nothing was written, nothing saved.
    expect(b.mirror.stateOf(hostedFile(2).token)).toMatchObject({ kind: 'pending' });
    expect(await w.deletes()).toHaveLength(1);
    down = false;
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(b.mirror);
    expect(b.mirror.stateOf(hostedFile(2).token)).toMatchObject({ kind: 'saved', descriptionUrl: url });
    expect(await w.deletes()).toEqual([]);
    expect(await w.exists(url)).toBe(true);
  });
});

describe('a waiter that aborts while another operation holds the copy', () => {
  it('leaves the queue without holding up or breaking the copy: the held delete finishes, and a later start copies the item whole', async () => {
    const w = await world();
    const a = w.open();
    await a.mirror.start();
    await a.mirror.enqueue(hostedFile(1).token);
    await settle(a.mirror);
    const url = urlOf(a.mirror, 1);
    let openGate: () => void = () => undefined;
    w.plan.hold = new Promise<void>((resolve) => (openGate = resolve));
    w.plan.deletes = 0;
    w.hosted.files.delete(hostedFile(1).token);
    a.events.emit({ type: 'deleted', token: hostedFile(1).token });
    await spin();
    await a.mirror.enqueue(hostedFile(2).token); // adopts the copy: waits for the store's lock behind the delete
    await spin();
    const stopped = a.mirror.stop(); // aborts the waiter
    await spin();
    openGate();
    await stopped;
    await spin();
    expect(a.mirror.stateOf(hostedFile(2).token)).not.toMatchObject({ kind: 'saved' });
    w.plan.hold = null;
    const b = w.open();
    await b.mirror.start();
    await settle(b.mirror);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(b.mirror);
    expect(b.mirror.stateOf(hostedFile(2).token)).toMatchObject({ kind: 'saved' });
    const saved = b.mirror.stateOf(hostedFile(2).token) as { descriptionUrl: string };
    expect(await w.exists(saved.descriptionUrl)).toBe(true);
    expect(await w.exists(url)).toBe(true);
  });
});
