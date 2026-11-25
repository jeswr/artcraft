import { describe, expect, it, vi } from 'vitest';
import { mintPodAssetRef, podAssetKey } from './ref.js';
import { createPodLibraryController, PodLibraryOpenError } from './library.js';
import { fakeLibrary } from './testing.js';

const ALICE = 'https://alice.example/profile/card#me';
const BOB = 'https://bob.example/profile/card#me';

function setup(initial: string | null = ALICE) {
  const world = { key: initial as string | null, built: [] as ReturnType<typeof fakeLibrary>[], failNext: false, gate: null as Promise<void> | null };
  const build = vi.fn(async (_key: string, _signal: AbortSignal) => {
    if (world.gate) await world.gate;
    if (world.failNext) {
      world.failNext = false;
      throw new Error('https://secret.example/token?x=1');
    }
    const library = fakeLibrary();
    world.built.push(library);
    return library;
  });
  const controller = createPodLibraryController({ getSessionKey: () => world.key, build });
  return { world, build, controller };
}

describe('the pod library controller', () => {
  it('builds once per account and shares the library', async () => {
    const { controller, build, world } = setup();
    const [a, b] = await Promise.all([controller.open(), controller.open()]);
    expect(a).toBe(b);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0]?.[0]).toBe(ALICE);
    expect(world.built[0]?.tileLoader.purge).not.toHaveBeenCalled();
  });

  it('purges the loader when the pod is disconnected', async () => {
    const { controller, world } = setup();
    await controller.open();
    world.key = null;
    controller.sync();
    expect(world.built[0]?.tileLoader.purge).toHaveBeenCalledTimes(1);
    expect(world.built[0]?.close).toHaveBeenCalledTimes(1);
    await expect(controller.open()).rejects.toMatchObject({ kind: 'not-connected' });
  });

  it('purges everything when the account changes, even if nobody called sync', async () => {
    const { controller, world, build } = setup();
    await controller.open();
    world.key = BOB;
    const next = await controller.open();
    expect(world.built[0]?.tileLoader.purge).toHaveBeenCalledTimes(1);
    expect(next).toBe(world.built[1]);
    expect(build.mock.calls.map((call) => call[0])).toEqual([ALICE, BOB]);
  });

  it('keeps the library while the account is the same', async () => {
    const { controller, world } = setup();
    await controller.open();
    controller.sync();
    expect(world.built[0]?.tileLoader.purge).not.toHaveBeenCalled();
  });

  it('purges on dispose', async () => {
    const { controller, world } = setup();
    await controller.open();
    controller.dispose();
    expect(world.built[0]?.tileLoader.purge).toHaveBeenCalledTimes(1);
  });

  it('aborts a build that is still running and purges what it produces late', async () => {
    const { controller, world, build } = setup();
    let open!: () => void;
    world.gate = new Promise<void>((resolve) => (open = resolve));
    const pending = controller.open();
    const settled = pending.catch((error: unknown) => error);
    world.key = null;
    controller.sync();
    expect((build.mock.calls[0]?.[1] as AbortSignal).aborted).toBe(true);
    open();
    expect(await settled).toBeInstanceOf(PodLibraryOpenError);
    expect(world.built[0]?.tileLoader.purge).toHaveBeenCalledTimes(1);
  });

  it('does not remember a failed build, and says nothing about why', async () => {
    const { controller, world } = setup();
    world.failNext = true;
    const error = await controller.open().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PodLibraryOpenError);
    expect(JSON.stringify(error)).not.toContain('secret');
    expect((error as Error).message).toBe('failed');
    await expect(controller.open()).resolves.toBeDefined();
  });

  it('forgets the keys it handed out for the previous account on teardown', async () => {
    const { controller } = setup();
    const ref = mintPodAssetRef('https://alice.example/lib/2026/06/d1');
    const other = mintPodAssetRef('https://alice.example/lib/2026/06/d2');
    expect(podAssetKey(ref)).toBe('pod-1');
    expect(podAssetKey(other)).toBe('pod-2');
    await controller.open();
    controller.dispose();
    // The map no longer holds the old account's URLs: counting starts again.
    expect(podAssetKey(other)).toBe('pod-1');
  });
});
