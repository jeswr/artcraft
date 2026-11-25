import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyticsAllowed,
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
  const host = (over: Record<string, unknown> = {}) => ({ enabled: true, storageOrigins: [], headerPolicy: false, ...over });

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
    vi.stubGlobal(HOST_POD_MODE_KEY, { enabled: false, storageOrigins: [], headerPolicy: false });
    expect(readHostPodMode()).toEqual({ enabled: false, storageOrigins: [], headerPolicy: false });
    for (const bad of ['yes', null, { enabled: 'yes' }, { enabled: true, storageOrigins: [1], headerPolicy: true }, { enabled: true, storageOrigins: [], headerPolicy: true, issuer: 5 }]) {
      vi.stubGlobal(HOST_POD_MODE_KEY, bad);
      expect(readHostPodMode()).toEqual({ enabled: true, storageOrigins: [], headerPolicy: false });
    }
  });

  it('reports a policy only in a pod window, from the header or the meta element', () => {
    expect(podPolicyApplied({ readHost: () => host({ enabled: false, headerPolicy: true }) })).toBe(false);
    resetPodWindowForTests();
    expect(podPolicyApplied({ readHost: () => host() })).toBe(false);
    markMetaPolicyApplied();
    expect(podPolicyApplied()).toBe(true);
    resetPodWindowForTests();
    expect(podPolicyApplied({ readHost: () => host({ headerPolicy: true }) })).toBe(true);
  });
});
