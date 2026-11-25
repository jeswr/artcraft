import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryMirrorJournal } from './journal.js';
import type { PodMirror as PodMirrorType } from './mirror.js';
import { ACCOUNT, HOSTED_TOKEN_PREFIX, fakeBytes, fakeEvents, fakeHosted, fakeNetwork, fakeSession, fakeStore, hostedFile, openFake } from './testing.js';

const URL_ = 'https://pod.example/alice/creative-assets/2026/06/shared';
const token = (n: number) => `${HOSTED_TOKEN_PREFIX}${n}`;

/** A Web Locks fake: exclusive, FIFO per name, shared by every "window" in the test. */
function fakeLocks() {
  const tails = new Map<string, Promise<unknown>>();
  const requests: string[] = [];
  return {
    requests,
    async request<T>(name: string, callback: () => Promise<T>): Promise<T> {
      requests.push(name);
      const previous = tails.get(name) ?? Promise.resolve();
      const run = previous.then(callback);
      tails.set(name, run.then(() => undefined, () => undefined));
      return run;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-10T00:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});

const settle = async (mirror: PodMirrorType) => {
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(0);
    await mirror.idle();
  }
};

/** A fresh copy of the engine's module, as another window of the app would have: its own queue and removal clock. */
async function window_(journal: ReturnType<typeof createMemoryMirrorJournal>, store: ReturnType<typeof fakeStore>) {
  vi.resetModules();
  const { PodMirror } = await import('./mirror.js');
  const hosted = fakeHosted([hostedFile(1), hostedFile(2)]);
  const events = fakeEvents();
  const mirror = new PodMirror({ account: ACCOUNT, journal, hosted, openStore: openFake(store), fetchPublicBytes: fakeBytes(hosted).fetch, session: fakeSession(), network: fakeNetwork(), events, random: () => 0.5 });
  return { mirror, events };
}

describe('the copy lock', () => {
  it('uses the Web Locks API, keyed by the copy address, when the browser has it', async () => {
    const locks = fakeLocks();
    vi.stubGlobal('navigator', { locks });
    const store = fakeStore();
    store.fixedUrl = URL_;
    const w = await window_(createMemoryMirrorJournal(), store);
    await w.mirror.start();
    await w.mirror.enqueue(token(1));
    await settle(w.mirror);
    expect(locks.requests).toContain(`artcraft-pod-copy:${URL_}`);
    expect(w.mirror.stateOf(token(1))).toMatchObject({ kind: 'saved' });
  });

  it('works without it, in this window only', async () => {
    vi.stubGlobal('navigator', {});
    const store = fakeStore();
    store.fixedUrl = URL_;
    const w = await window_(createMemoryMirrorJournal(), store);
    await w.mirror.start();
    await w.mirror.enqueue(token(1));
    await settle(w.mirror);
    expect(w.mirror.stateOf(token(1))).toMatchObject({ kind: 'saved' });
  });

  it('covers two windows on one journal: a delete in one while the other adopts the same bytes does not leave a dead link', async () => {
    vi.stubGlobal('navigator', { locks: fakeLocks() });
    const journal = createMemoryMirrorJournal();
    const store = fakeStore();
    store.fixedUrl = URL_;
    const one = await window_(journal, store);
    await one.mirror.start();
    await one.mirror.enqueue(token(1));
    await settle(one.mirror);
    const two = await window_(journal, store);
    await two.mirror.start();
    await settle(two.mirror);
    // Window two is mid-put of the same bytes as token 2: the store reports it adopted the copy.
    store.existed = true;
    const realPut = store.put.bind(store);
    store.put = async (input) => {
      const outcome = await realPut(input);
      store.existed = false; // the next put finds the description gone and writes it
      return outcome;
    };
    let release: () => void = () => undefined;
    store.gate = new Promise<void>((resolve) => (release = resolve));
    await two.mirror.enqueue(token(2));
    await vi.advanceTimersByTimeAsync(0);
    store.gate = null;
    // Window one handles the hosted delete of token 1: nothing pairs with the copy yet, so it is removed.
    one.events.emit({ type: 'deleted', token: token(1) });
    await settle(one.mirror);
    expect(store.removed).toEqual([URL_]);
    release();
    await settle(two.mirror);
    // Window two's own clock never saw the delete, but the pod answer did: it wrote the copy again.
    expect(two.mirror.stateOf(token(2))).toMatchObject({ kind: 'saved', descriptionUrl: URL_ });
    expect((await store.get(URL_)).ok).toBe(true);
  });
});
