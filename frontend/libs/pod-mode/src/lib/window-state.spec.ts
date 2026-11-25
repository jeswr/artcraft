import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyticsAllowed,
  gatePodMode,
  HOST_POD_MODE_KEY,
  isPodMode,
  latchPodWindow,
  markMetaPolicyApplied,
  podPolicyApplied,
  readHostPodMode,
  markAnalyticsLoaded,
  POD_MODE_FLAG_KEY,
  readPodModeFlag,
  resetPodWindowForTests,
  sessionRestoreAllowed,
} from './window-state.js';
import { memoryStorage, throwingStorage } from './testing.js';

afterEach(() => {
  resetPodWindowForTests();
  vi.unstubAllGlobals();
});

describe('flag reading', () => {
  it('is false by default and only the exact value counts', () => {
    const storage = memoryStorage();
    expect(readPodModeFlag({ storage })).toBe(false);
    for (const v of ['0', 'true', '', ' 1']) {
      storage.setItem(POD_MODE_FLAG_KEY, v);
      expect(readPodModeFlag({ storage })).toBe(false);
    }
    storage.setItem(POD_MODE_FLAG_KEY, '1');
    expect(readPodModeFlag({ storage })).toBe(true);
  });

  it('fails closed when storage throws', () => {
    expect(readPodModeFlag({ storage: throwingStorage })).toBe(true);
  });

  it('fails closed when localStorage does not exist', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(readPodModeFlag()).toBe(true);
  });
});

describe('per-window latch', () => {
  it('decides once: a flag written later does not change this window', () => {
    const storage = memoryStorage();
    expect(isPodMode({ storage })).toBe(false);
    storage.setItem(POD_MODE_FLAG_KEY, '1');
    expect(isPodMode({ storage })).toBe(false);
    expect(analyticsAllowed({ storage })).toBe(true);
  });

  it('a pod window stays pod when the flag is later cleared', () => {
    const storage = memoryStorage();
    storage.setItem(POD_MODE_FLAG_KEY, '1');
    expect(latchPodWindow({ storage })).toBe(true);
    storage.removeItem(POD_MODE_FLAG_KEY);
    expect(isPodMode({ storage })).toBe(true);
    expect(analyticsAllowed({ storage })).toBe(false);
  });

  it('a window that cannot read storage latches as pod mode', () => {
    expect(isPodMode({ storage: throwingStorage })).toBe(true);
    expect(analyticsAllowed({ storage: throwingStorage })).toBe(false);
  });
});

describe('sessionRestoreAllowed', () => {
  it('is true only in a pod window where no analytics loader ran', () => {
    const storage = memoryStorage();
    storage.setItem(POD_MODE_FLAG_KEY, '1');
    latchPodWindow({ storage });
    expect(sessionRestoreAllowed()).toBe(true);
    markAnalyticsLoaded();
    expect(sessionRestoreAllowed()).toBe(false);
  });

  it('is false in a window that is not pod mode', () => {
    latchPodWindow({ storage: memoryStorage() });
    expect(sessionRestoreAllowed()).toBe(false);
  });
});

describe('the shell is the authority', () => {
  const host = (over: Record<string, unknown> = {}) => ({
    enabled: true,
    storageOrigins: [],
    headerPolicy: false,
    credentialsMayExist: true,
    ...over,
  });

  it('a planted localStorage flag does not make a window a pod window', () => {
    const storage = memoryStorage();
    storage.setItem(POD_MODE_FLAG_KEY, '1');
    expect(isPodMode({ storage, readHost: () => host({ enabled: false }) })).toBe(false);
  });

  it('a pod window needs no flag in localStorage, and a cleared flag changes nothing', () => {
    const storage = memoryStorage();
    expect(isPodMode({ storage, readHost: () => host() })).toBe(true);
    expect(storage.log).toEqual([]);
  });

  it('reads the global the initialization script defines and fails closed when it is malformed', () => {
    expect(readHostPodMode()).toBeNull();
    vi.stubGlobal(HOST_POD_MODE_KEY, { enabled: false, storageOrigins: [], headerPolicy: false, credentialsMayExist: false });
    expect(readHostPodMode()).toEqual({ enabled: false, storageOrigins: [], headerPolicy: false, credentialsMayExist: false });
    vi.stubGlobal(HOST_POD_MODE_KEY, { enabled: true, issuer: 'https://id.example', storageOrigins: [], headerPolicy: true, credentialsMayExist: true, freshConnect: 'https://id.example' });
    expect(readHostPodMode()?.freshConnect).toBe('https://id.example');
    const closed = { enabled: true, storageOrigins: [], headerPolicy: false, credentialsMayExist: true };
    const good = { enabled: true, storageOrigins: [], headerPolicy: true, credentialsMayExist: true };
    for (const bad of [
      'yes',
      null,
      { enabled: 'yes' },
      { ...good, storageOrigins: [1] },
      { ...good, issuer: 5 },
      { ...good, freshConnect: 5 },
      { enabled: false, storageOrigins: [], headerPolicy: false },
      { ...good, credentialsMayExist: 'no' },
    ]) {
      vi.stubGlobal(HOST_POD_MODE_KEY, bad);
      expect(readHostPodMode()).toEqual(closed);
    }
  });

  it('loads no analytics while credentials may exist, even outside pod mode', () => {
    expect(analyticsAllowed({ readHost: () => host({ enabled: false, credentialsMayExist: true }) })).toBe(false);
    resetPodWindowForTests();
    expect(analyticsAllowed({ readHost: () => host({ enabled: false, credentialsMayExist: false }) })).toBe(true);
    resetPodWindowForTests();
    expect(analyticsAllowed({ readHost: () => host({ enabled: true }) })).toBe(false);
  });

  describe('gatePodMode (production)', () => {
    const prod = (readHost: () => ReturnType<typeof host> | null) => ({ readHost, dev: false });

    it('needs the shell: enabled, with its header policy in force', () => {
      expect(gatePodMode(prod(() => host({ headerPolicy: true })))).toBe('ok');
      resetPodWindowForTests();
      expect(gatePodMode(prod(() => host({ headerPolicy: false })))).toBe('policy-not-applied');
      resetPodWindowForTests();
      expect(gatePodMode(prod(() => host({ enabled: false, headerPolicy: true })))).toBe('not-pod-window');
    });

    it('does not accept a meta policy, the writable latch or a missing shell', () => {
      markMetaPolicyApplied();
      expect(gatePodMode(prod(() => host({ headerPolicy: false })))).toBe('policy-not-applied');
      resetPodWindowForTests();
      expect(gatePodMode(prod(() => null))).toBe('policy-not-applied');
    });

    it('cannot be switched on by overwriting the latch object', () => {
      const planted = {
        podMode: true,
        analyticsLoaded: false,
        metaPolicy: true,
        host: host({ headerPolicy: true }),
      };
      (globalThis as Record<symbol, unknown>)[Symbol.for('artcraft.podWindowState')] = planted;
      expect(gatePodMode(prod(() => host({ enabled: false, headerPolicy: false })))).toBe('not-pod-window');
      expect(gatePodMode(prod(() => null))).toBe('policy-not-applied');
    });

    it('refuses once an analytics loader ran', () => {
      expect(gatePodMode(prod(() => host({ headerPolicy: true })))).toBe('ok');
      markAnalyticsLoaded();
      expect(gatePodMode(prod(() => host({ headerPolicy: true })))).toBe('window-not-clean');
    });
  });

  describe('gatePodMode (development)', () => {
    it('accepts the meta policy alone, with or without a shell', () => {
      const dev = (readHost: () => ReturnType<typeof host> | null) => ({ readHost, dev: true });
      expect(gatePodMode(dev(() => host()))).toBe('policy-not-applied');
      markMetaPolicyApplied();
      expect(gatePodMode(dev(() => host()))).toBe('ok');
      resetPodWindowForTests();
      const storage = memoryStorage();
      storage.setItem(POD_MODE_FLAG_KEY, '1');
      expect(gatePodMode({ ...dev(() => null), storage })).toBe('policy-not-applied');
      markMetaPolicyApplied();
      expect(gatePodMode({ ...dev(() => null), storage })).toBe('ok');
    });
  });

  it('reports a policy only in a pod window, from the header or (in development) the meta element', () => {
    expect(podPolicyApplied({ dev: true, readHost: () => host({ enabled: false, headerPolicy: true }) })).toBe(false);
    resetPodWindowForTests();
    expect(podPolicyApplied({ dev: true, readHost: () => host() })).toBe(false);
    markMetaPolicyApplied();
    expect(podPolicyApplied({ dev: true })).toBe(true);
    resetPodWindowForTests();
    expect(podPolicyApplied({ dev: true, readHost: () => host({ headerPolicy: true }) })).toBe(true);
  });
});
