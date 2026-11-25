import type { StorageLike } from './window-state.js';

export function memoryStorage(): StorageLike & { data: Map<string, string>; log: string[] } {
  const data = new Map<string, string>();
  const log: string[] = [];
  return {
    data,
    log,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      log.push(`set ${k}`);
      data.set(k, v);
    },
    removeItem: (k) => {
      log.push(`remove ${k}`);
      data.delete(k);
    },
  };
}

export const throwingStorage: StorageLike = {
  getItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
  setItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
  removeItem: () => {
    throw new DOMException('denied', 'SecurityError');
  },
};
