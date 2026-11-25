import { type AddOriginResult, type OriginPurpose, parseOrigin } from '@storyteller/pod-mode';

/**
 * The window's connect policy only lists the sign-in server and the storage origins the person
 * approved in the app's native dialog, so a pod whose storage (or Type Index) is on another
 * origin is unreachable until that origin is admitted. The origin comes from profile data, which
 * a hostile profile controls, so it is never added silently: each new one is handed to the app,
 * which validates it and asks the person in a dialog that names it. Only an origin crosses to
 * the app, never a path, query or token.
 *
 * The app, not this gate, enforces the limits (an origin the person declined is never asked
 * about again in a pod-mode session, a session shows a fixed number of dialogs, each refusal
 * lengthens the wait): a compromised page can call the command directly. This gate is a thin
 * convenience over that: it asks once per origin, in turn, and remembers what the app answered
 * so the same window does not ask the app again for nothing.
 */
export type OriginAdmission = {
  /** Origins this window's policy already allows: the sign-in server and every approved storage origin. */
  known(): readonly string[];
  /** Asks the app to admit one more (validation and native dialog happen there). */
  request(origin: string, purpose: OriginPurpose): Promise<AddOriginResult>;
};

/**
 * Why a request to an origin was not sent. Closed set. `declined` and `limit` are final for this
 * window; the rest can succeed later (`too-fast`: press Allow again after the wait; `busy`: the
 * app is showing another dialog or cooling down; `unavailable`: the app could not do it).
 * `needs-approval`: the origin is not allowed yet and the caller chose not to open the dialog
 * itself (pod-auth's own reads: the page explains first, then asks).
 */
export type RefusalReason = 'declined' | 'limit' | 'invalid' | 'too-fast' | 'busy' | 'unavailable' | 'needs-approval';

const MESSAGES: Record<RefusalReason, string> = {
  declined: 'storage origin not allowed',
  limit: 'storage origin limit reached',
  invalid: 'storage origin not valid',
  'too-fast': 'storage origin answer too fast',
  busy: 'storage origin request busy',
  unavailable: 'storage origin request failed',
  'needs-approval': 'storage origin needs approval',
};

/** A fixed message per reason: it never carries the URL that was refused. */
export class StorageOriginRefused extends Error {
  readonly reason: RefusalReason;
  /**
   * The bare origin the request named, for the page to show the person. Never in the message,
   * so a log of the error carries no URL.
   */
  readonly origin: string;
  constructor(reason: RefusalReason = 'declined', origin = '') {
    super(MESSAGES[reason]);
    this.name = 'StorageOriginRefused';
    this.reason = reason;
    this.origin = origin;
  }
}

export type OriginGate = {
  /**
   * Resolves when requests to `origin` may go out; rejects with `StorageOriginRefused`
   * otherwise, or with the signal's reason when `signal` aborts while it waits.
   */
  allow(origin: string, signal?: AbortSignal, options?: AllowOptions): Promise<void>;
};

export type AllowOptions = {
  /**
   * Default true: an unlisted origin asks the app (native dialog). False: reject at once with
   * `needs-approval`, so the caller can explain before asking.
   */
  prompt?: boolean;
  /** What the app's dialog says the address is for. Default `storage`: the pod's files. */
  purpose?: OriginPurpose;
};

/**
 * `allowLoopback` is the build's own flag (`config.allowLoopbackHttp`); a release build refuses
 * `localhost` here exactly as the app does.
 */
export function createOriginGate(admission: OriginAdmission, allowLoopback = false): OriginGate {
  const admitted = new Set<string>();
  const declined = new Set<string>();
  const invalid = new Set<string>();
  const pending = new Map<string, Promise<void>>();
  let limit = false;
  // The app shows one dialog at a time; asking in turn avoids `busy` between two of our own.
  let queue: Promise<unknown> = Promise.resolve();

  const ask = async (origin: string, purpose: OriginPurpose): Promise<void> => {
    let answer: AddOriginResult;
    try {
      answer = await admission.request(origin, purpose);
    } catch (error) {
      throw refusalFor(error, origin);
    }
    if (answer === 'requested') {
      admitted.add(origin);
      return;
    }
    if (answer === 'too-fast') throw new StorageOriginRefused('too-fast', origin);
    declined.add(origin);
    throw new StorageOriginRefused('declined', origin);
  };

  const refusalFor = (error: unknown, origin: string): StorageOriginRefused => {
    switch (wordOf(error)) {
      case 'refused_origin':
        declined.add(origin);
        return new StorageOriginRefused('declined', origin);
      case 'too_many_prompts':
      case 'too_many_origins':
        limit = true;
        return new StorageOriginRefused('limit', origin);
      case 'invalid_origin':
        invalid.add(origin);
        return new StorageOriginRefused('invalid', origin);
      case 'busy':
      case 'cooling_down':
        return new StorageOriginRefused('busy', origin);
      default:
        return new StorageOriginRefused('unavailable', origin);
    }
  };

  return {
    allow(value, signal, options) {
      const origin = parseOrigin(value, allowLoopback);
      if (origin === null) return Promise.reject(new StorageOriginRefused('invalid'));
      if (admitted.has(origin) || admission.known().includes(origin)) return Promise.resolve();
      if (declined.has(origin)) return Promise.reject(new StorageOriginRefused('declined', origin));
      if (invalid.has(origin)) return Promise.reject(new StorageOriginRefused('invalid', origin));
      if (limit) return Promise.reject(new StorageOriginRefused('limit', origin));
      if (options?.prompt === false) return Promise.reject(new StorageOriginRefused('needs-approval', origin));
      let request = pending.get(origin);
      if (!request) {
        const turn = queue.then(() => ask(origin, options?.purpose ?? 'storage'));
        queue = turn.catch(() => undefined);
        request = turn.finally(() => pending.delete(origin));
        pending.set(origin, request);
      }
      return signal ? untilAborted(request, signal) : request;
    },
  };
}

/**
 * Wraps a fetch so a request to an unadmitted origin asks first (the default), or is refused at
 * once with `needs-approval` (`prompt: false`). The request itself goes to `inner` unchanged:
 * the same `Request` (so its `redirect`, `credentials` and `signal` are kept) or the same
 * arguments, and the response comes back as it is.
 */
export function gateFetch(inner: typeof fetch, gate: OriginGate, options: AllowOptions = {}): typeof fetch {
  return async (input, init) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined) ?? undefined;
    await gate.allow(originOf(input), signal, options);
    return inner(input, init);
  };
}

/** The gate's refusal anywhere in an error's cause chain (pod-auth wraps it as `InjectedFetchError`). */
export function refusalOf(error: unknown): StorageOriginRefused | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    if (current instanceof StorageOriginRefused) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
}

/** pod-auth's `InvalidInjectedResponseError` anywhere in the chain: the supplied fetch misbehaved. */
export function isInvalidInjectedResponse(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth++) {
    if ((current as { name?: unknown }).name === 'InvalidInjectedResponseError') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function originOf(input: Parameters<typeof fetch>[0]): string {
  try {
    const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return new URL(href).origin;
  } catch {
    return '';
  }
}

/** The app's error word (`pod_mode_*` commands reject with a fixed word), or '' for anything else. */
function wordOf(error: unknown): string {
  const text = typeof error === 'string' ? error : error instanceof Error ? error.message : '';
  return /^[a-z_]{1,32}$/.test(text) ? text : '';
}

function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
