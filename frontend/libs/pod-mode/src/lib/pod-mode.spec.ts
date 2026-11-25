import { describe, expect, it, vi } from 'vitest';
import { enterPodMode, leavePodMode, readPodOrigins } from './pod-mode.js';
import { POD_MODE_FLAG_KEY, POD_MODE_ORIGINS_KEY, readPodModeFlag, type StorageLike } from './window-state.js';
import { memoryStorage, throwingStorage } from './testing.js';

describe('enterPodMode', () => {
  it('persists origins then flag, then reloads', () => {
    const storage = memoryStorage();
    const reload = vi.fn(() => {
      // by the time of the reload both keys are already written
      expect(readPodModeFlag({ storage })).toBe(true);
      expect(readPodOrigins({ storage })).toEqual({ issuer: 'https://id.example', storage: 'https://pod.example:8443' });
    });
    enterPodMode({ issuer: 'https://id.example', storage: 'https://pod.example:8443' }, { storage, reload });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.log).toEqual([`set ${POD_MODE_ORIGINS_KEY}`, `set ${POD_MODE_FLAG_KEY}`]);
  });

  it('does not reload and rolls back both keys when writing the flag fails', () => {
    const storage = memoryStorage();
    const failing: StorageLike = {
      ...storage,
      setItem: (k, v) => {
        if (k === POD_MODE_FLAG_KEY) throw new Error('quota');
        storage.setItem(k, v);
      },
    };
    const reload = vi.fn();
    expect(() => enterPodMode({ issuer: 'https://id.example' }, { storage: failing, reload })).toThrow('quota');
    expect(reload).not.toHaveBeenCalled();
    expect(storage.data.size).toBe(0);
  });

  it('rethrows the original error even when the rollback also fails', () => {
    const reload = vi.fn();
    expect(() => enterPodMode({ issuer: 'https://id.example' }, { storage: throwingStorage, reload })).toThrow(
      'denied',
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it('touches nothing and does not reload when origins are invalid', () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    expect(() => enterPodMode({ issuer: 'https://x.example/path' }, { storage, reload })).toThrow();
    expect(() => enterPodMode({ issuer: 'https://ok.example', storage: 'ftp://x' }, { storage, reload })).toThrow();
    expect(storage.log).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('readPodOrigins', () => {
  it('ignores corrupt or hostile remembered origins', () => {
    const storage = memoryStorage();
    storage.setItem(POD_MODE_ORIGINS_KEY, '{"issuer":"https://a.example; script-src *"}');
    expect(readPodOrigins({ storage })).toBeNull();
    storage.setItem(POD_MODE_ORIGINS_KEY, 'not json');
    expect(readPodOrigins({ storage })).toBeNull();
    expect(readPodOrigins({ storage: throwingStorage })).toBeNull();
  });
});

describe('leavePodMode', () => {
  const entered = () => {
    const storage = memoryStorage();
    storage.setItem(POD_MODE_FLAG_KEY, '1');
    storage.setItem(POD_MODE_ORIGINS_KEY, '{"issuer":"https://id.example"}');
    storage.log.length = 0;
    return storage;
  };

  it('wipes credentials first, then clears the flag, then reloads', async () => {
    const storage = entered();
    const order: string[] = [];
    const wipe = vi.fn(async () => {
      order.push('wipe');
      expect(readPodModeFlag({ storage })).toBe(true); // flag still set while wiping
    });
    const reload = vi.fn(() => {
      order.push('reload');
      expect(storage.data.size).toBe(0); // cleared before reload
    });
    await leavePodMode(wipe, { storage, reload });
    expect(order).toEqual(['wipe', 'reload']);
  });

  it('stays in pod mode and rethrows when the wipe fails', async () => {
    const storage = entered();
    const reload = vi.fn();
    await expect(leavePodMode(async () => Promise.reject(new Error('idb locked')), { storage, reload })).rejects.toThrow(
      'idb locked',
    );
    expect(readPodModeFlag({ storage })).toBe(true);
    expect(storage.log).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('treats a synchronously throwing wipe as a failure too', async () => {
    const storage = entered();
    const reload = vi.fn();
    await expect(
      leavePodMode(() => {
        throw new Error('sync');
      }, { storage, reload }),
    ).rejects.toThrow('sync');
    expect(reload).not.toHaveBeenCalled();
  });
});
