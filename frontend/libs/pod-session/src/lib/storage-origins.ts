import { parseOrigin } from '@storyteller/pod-mode';

/**
 * The window's connect policy only lists the sign-in server and the storage origins the person
 * approved in the app's native dialog, so a pod whose storage (or WebID document) is on another
 * origin is unreachable until that origin is admitted. The origin comes from profile data, which
 * a hostile profile controls, so it is never added silently: each new one is handed to the app,
 * which validates it and asks the person in a dialog that names it. Only an origin crosses to
 * the app, never a path, query or token.
 */
export type OriginAdmission = {
  /** Origins this window's policy already allows: the sign-in server and every approved storage origin. */
  known(): readonly string[];
  /** Asks the app to admit one more (validation and native dialog happen there). */
  request(origin: string): Promise<'requested' | 'declined'>;
};

/** At most this many dialogs a window opens for storage origins; the app caps the saved list too. */
export const MAX_ORIGIN_REQUESTS_PER_WINDOW = 4;

/** A fixed message: it never carries the URL that was refused. */
export class StorageOriginRefused extends Error {
  constructor() {
    super('storage origin not allowed');
    this.name = 'StorageOriginRefused';
  }
}

export type OriginGate = {
  /** Resolves when requests to `origin` may go out; rejects with `StorageOriginRefused` otherwise. */
  allow(origin: string): Promise<void>;
};

/**
 * Admits origins one at a time, the first time a request needs them. A refusal, an error from
 * the app (invalid origin, too many origins, cool-down) or reaching the per-window limit is
 * remembered: later requests to an unadmitted origin fail without another dialog. When the app
 * admits an origin it rebuilds the window, so a pending request normally never resolves here;
 * the rebuilt window finds the origin already in its policy.
 */
export function createOriginGate(admission: OriginAdmission, maxRequests = MAX_ORIGIN_REQUESTS_PER_WINDOW): OriginGate {
  const admitted = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  let refused = false;
  let asked = 0;

  const ask = async (origin: string): Promise<void> => {
    try {
      if ((await admission.request(origin)) === 'requested') {
        admitted.add(origin);
        return;
      }
    } catch {
      // fall through: any failure is a refusal
    }
    refused = true;
    throw new StorageOriginRefused();
  };

  return {
    allow(value) {
      const origin = parseOrigin(value);
      if (origin === null) return Promise.reject(new StorageOriginRefused());
      if (admitted.has(origin) || admission.known().includes(origin)) return Promise.resolve();
      const inFlight = pending.get(origin);
      if (inFlight) return inFlight;
      if (refused || asked >= maxRequests) return Promise.reject(new StorageOriginRefused());
      asked += 1;
      const request = ask(origin).finally(() => pending.delete(origin));
      pending.set(origin, request);
      return request;
    },
  };
}

/** Wraps the session's authenticated fetch so a request to an unadmitted origin asks first. */
export function gateFetch(inner: typeof fetch, gate: OriginGate): typeof fetch {
  return async (input, init) => {
    await gate.allow(originOf(input));
    return inner(input, init);
  };
}

function originOf(input: Parameters<typeof fetch>[0]): string {
  try {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(href).origin;
  } catch {
    return '';
  }
}
