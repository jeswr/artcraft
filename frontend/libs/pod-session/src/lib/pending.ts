import { type OriginPurpose, parseOrigin } from '@storyteller/pod-mode';
import { parseSignInInput } from './issuer.js';

/** What the person typed, as pod-auth's login hint. Public addresses only. */
export type SignInHint = { kind: 'issuer'; issuer: string } | { kind: 'webid'; webId: string };

/**
 * What survives the window rebuilds of a sign-in that needs an origin approved: the hint the
 * person typed and, while waiting, the origin that was approved. Never a token, code, verifier
 * or callback URL. Cleared on success, decline, cancel and leave.
 */
export type PendingSignIn = { hint: SignInHint; origin?: string; purpose?: OriginPurpose };

const PURPOSES: readonly OriginPurpose[] = ['profile', 'storage', 'sign-in', 'app-identity'];

export interface PendingStore {
  get(): PendingSignIn | null;
  set(value: PendingSignIn | null): void;
}

const PENDING_KEY = 'artcraft.podSession.pending';

/** The origin the app is asked to confirm for this hint. */
export function originOfHint(hint: SignInHint, allowLoopback = false): string | null {
  try {
    return parseOrigin(new URL(hint.kind === 'issuer' ? hint.issuer : hint.webId).origin, allowLoopback);
  } catch {
    return null;
  }
}

export function localStoragePending(storage?: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>, allowLoopbackHttp = false): PendingStore {
  const pick = () => storage ?? globalThis.localStorage;
  return {
    get() {
      try {
        const raw = pick().getItem(PENDING_KEY);
        if (raw === null) return null;
        return validate(JSON.parse(raw), allowLoopbackHttp);
      } catch {
        return null;
      }
    },
    set(value) {
      try {
        if (value === null) pick().removeItem(PENDING_KEY);
        else pick().setItem(PENDING_KEY, JSON.stringify(value));
      } catch {
        // without it the person simply types the address again
      }
    },
  };
}

/** A value from page storage is untrusted: re-validate it the way fresh input is. */
function validate(value: unknown, allowLoopbackHttp: boolean): PendingSignIn | null {
  if (typeof value !== 'object' || value === null) return null;
  const { hint, origin, purpose } = value as { hint?: unknown; origin?: unknown; purpose?: unknown };
  if (typeof hint !== 'object' || hint === null) return null;
  const h = hint as Record<string, unknown>;
  let checked: SignInHint | null = null;
  if (h['kind'] === 'issuer' && typeof h['issuer'] === 'string') {
    const parsed = parseSignInInput(h['issuer'], allowLoopbackHttp);
    if (parsed?.kind === 'issuer') checked = { kind: 'issuer', issuer: parsed.issuer };
  } else if (h['kind'] === 'webid' && typeof h['webId'] === 'string') {
    const parsed = parseSignInInput(h['webId'], allowLoopbackHttp);
    if (parsed?.kind === 'webid') checked = { kind: 'webid', webId: parsed.webId };
  }
  if (checked === null) return null;
  if (origin === undefined) return { hint: checked };
  const pendingOrigin = parseOrigin(origin, allowLoopbackHttp);
  if (pendingOrigin === null) return null;
  const checkedPurpose = PURPOSES.find((p) => p === purpose);
  return { hint: checked, origin: pendingOrigin, ...(checkedPurpose ? { purpose: checkedPurpose } : {}) };
}
