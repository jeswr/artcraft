import { afterEach, describe, expect, it, vi } from 'vitest';
import { addStorageOrigin, consumeFreshConnect, credentialsCleared, enterPodMode, leavePodMode, readPodModeOrigins, readPodOrigins, reloadPodWindow } from './pod-mode.js';
import {
  type HostPodMode,
  type PodModeRequests,
  POD_MODE_FLAG_KEY,
  POD_MODE_ORIGINS_KEY,
  readPodModeFlag,
  resetPodWindowForTests,
  type StorageLike,
} from './window-state.js';
import { memoryStorage, throwingStorage } from './testing.js';

describe('enterPodMode', () => {
  it('persists origins then flag, then reloads (dev fallback without a shell)', async () => {
    const storage = memoryStorage();
    const reload = vi.fn(() => {
      // by the time of the reload both keys are already written
      expect(readPodModeFlag({ storage })).toBe(true);
      expect(readPodOrigins({ storage })).toEqual({ issuer: 'https://id.example', storage: 'https://pod.example:8443' });
    });
    expect(await enterPodMode({ issuer: 'https://id.example', storage: 'https://pod.example:8443' }, { storage, reload })).toBe('requested');
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.log).toEqual([`set ${POD_MODE_ORIGINS_KEY}`, `set ${POD_MODE_FLAG_KEY}`]);
  });

  it('does not reload and rolls back both keys when writing the flag fails', async () => {
    const storage = memoryStorage();
    const failing: StorageLike = {
      ...storage,
      setItem: (k, v) => {
        if (k === POD_MODE_FLAG_KEY) throw new Error('quota');
        storage.setItem(k, v);
      },
    };
    const reload = vi.fn();
    await expect(enterPodMode({ issuer: 'https://id.example' }, { storage: failing, reload })).rejects.toThrow('quota');
    expect(reload).not.toHaveBeenCalled();
    expect(storage.data.size).toBe(0);
  });

  it('rethrows the original error even when the rollback also fails', async () => {
    const reload = vi.fn();
    await expect(enterPodMode({ issuer: 'https://id.example' }, { storage: throwingStorage, reload })).rejects.toThrow(
      'denied',
    );
    expect(reload).not.toHaveBeenCalled();
  });

  it('touches nothing and does not reload when origins are invalid', async () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    await expect(enterPodMode({ issuer: 'https://x.example/path' }, { storage, reload })).rejects.toThrow();
    await expect(enterPodMode({ issuer: 'https://ok.example', storage: 'ftp://x' }, { storage, reload })).rejects.toThrow();
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

afterEach(() => resetPodWindowForTests());

function requests(over: Partial<PodModeRequests> = {}): PodModeRequests & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    requestEnter: async (o) => (calls.push(`enter ${o.issuer}`), 'requested'),
    requestAddStorageOrigin: async (o) => (calls.push(`add ${o}`), 'requested'),
    requestLeave: async () => void calls.push('leave'),
    requestReload: async () => void calls.push('reload'),
    requestCredentialsCleared: async () => void calls.push('cleared'),
    requestConsumeFresh: async () => (calls.push('consume'), 'https://id.example'),
    ...over,
  };
}

describe('with the desktop shell', () => {
  it('asks the shell instead of writing storage, and reports a declined confirmation', async () => {
    const storage = memoryStorage();
    const reload = vi.fn();
    const r = requests({ requestEnter: async () => 'declined' });
    expect(await enterPodMode({ issuer: 'https://id.example' }, { storage, reload, requests: r })).toBe('declined');
    expect(storage.log).toEqual([]);
    expect(reload).not.toHaveBeenCalled();
  });

  it('validates the issuer before it asks', async () => {
    const r = requests();
    await expect(enterPodMode({ issuer: 'https://id.example/x' }, { requests: r })).rejects.toThrow();
    expect(r.calls).toEqual([]);
  });

  it('adds a storage origin only through the shell, and only a valid one', async () => {
    const r = requests();
    await addStorageOrigin('https://pod.example', { requests: r });
    expect(r.calls).toEqual(['add https://pod.example']);
    await expect(addStorageOrigin('https://pod.example/x', { requests: r })).rejects.toThrow();
    await expect(addStorageOrigin('https://pod.example', {})).rejects.toThrow();
  });

  it('wipes first, then asks the shell to leave and never touches storage', async () => {
    const storage = memoryStorage();
    const r = requests();
    await leavePodMode(async () => void r.calls.push('wipe'), { storage, requests: r });
    expect(r.calls).toEqual(['wipe', 'leave']);
    expect(storage.log).toEqual([]);
  });

  it('does not ask the shell to leave when the wipe fails', async () => {
    const r = requests();
    await expect(leavePodMode(async () => Promise.reject(new Error('stuck')), { requests: r })).rejects.toThrow('stuck');
    expect(r.calls).toEqual([]);
  });

  it('can rebuild the window without changing the mode', async () => {
    const r = requests();
    await reloadPodWindow({ requests: r });
    expect(r.calls).toEqual(['reload']);
  });

  it('takes origins from the shell and ignores planted localStorage hints', () => {
    resetPodWindowForTests();
    const storage = memoryStorage();
    storage.setItem(POD_MODE_ORIGINS_KEY, '{"issuer":"https://planted.example"}');
    const host: HostPodMode = { enabled: true, issuer: 'https://id.example', storageOrigins: ['https://pod.example'], headerPolicy: true, credentialsMayExist: true };
    expect(readPodModeOrigins({ storage, readHost: () => host })).toEqual({
      issuer: 'https://id.example',
      storageOrigins: ['https://pod.example'],
    });
  });

  it('refuses hostile origins in the shell value and reports nothing when not in pod mode', () => {
    const read = (host: HostPodMode) => {
      resetPodWindowForTests();
      return readPodModeOrigins({ readHost: () => host });
    };
    const bad: HostPodMode = { enabled: true, issuer: 'https://a.example; script-src *', storageOrigins: [], headerPolicy: false, credentialsMayExist: true };
    expect(read(bad)).toBeNull();
    expect(read({ ...bad, issuer: 'https://ok.example', storageOrigins: ['x'] })).toBeNull();
    expect(read({ enabled: false, storageOrigins: [], headerPolicy: false, credentialsMayExist: true })).toBeNull();
    expect(read({ enabled: true, storageOrigins: [], headerPolicy: false, credentialsMayExist: true })).toEqual({ storageOrigins: [] });
  });
});

describe('credentialsCleared and consumeFreshConnect', () => {
  it('ask the shell', async () => {
    const r = requests();
    await credentialsCleared({ requests: r });
    expect(await consumeFreshConnect({ requests: r })).toBe('https://id.example');
    expect(r.calls).toEqual(['cleared', 'consume']);
  });

  it('refuse a fresh sign-in without a shell, and reload instead of clearing', async () => {
    await expect(consumeFreshConnect({})).rejects.toThrow();
    const reload = vi.fn();
    await credentialsCleared({ reload });
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
