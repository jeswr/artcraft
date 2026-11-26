/** Why the feature is off. Closed set; the UI maps each to a sentence. */
export type UnsupportedReason =
  | 'insecure-context'
  | 'web-locks-missing'
  | 'web-locks-broken'
  | 'indexeddb-missing'
  | 'webcrypto-missing'
  | 'key-not-persistable';

import type { OriginPurpose } from '@storyteller/pod-mode';

/**
 * What went wrong. Closed set so no message can carry a token, a callback URL or a host's
 * error text. The UI maps each to a sentence.
 */
export type PodSessionErrorKind =
  | 'invalid-issuer'
  | 'invalid-config'
  | 'not-configured'
  | 'policy-not-applied'
  | 'window-not-clean'
  | 'request-failed'
  | 'browser-open-failed'
  | 'sign-in-timed-out'
  | 'sign-in-failed'
  | 'restore-failed'
  /**
   * The connected session could not renew its token without the person (a refresh that failed, a
   * provider with no refresh token), so ArtCraft stopped using it rather than open the browser on
   * its own. The way back is "Sign in again".
   */
  | 'session-ended'
  /** ArtCraft is not ready to ask about signing in again yet (a dialog is open, or it waits after a refusal). */
  | 'sign-in-again-wait'
  /** ArtCraft has asked about signing in again as often as it does in one run. */
  | 'sign-in-again-limit'
  /** The person declined (or the app already refused) an address pod-auth needed to read. */
  | 'origin-declined'
  /** This pod-mode session has used up the addresses it may ask about. */
  | 'origin-limit'
  /** Allow was pressed too fast to be a considered answer; nothing was approved. */
  | 'approval-too-fast'
  /** A profile or provider document could not be read as expected. */
  | 'invalid-response'
  /** The stored sign-in data could not be deleted, or its deletion is still pending. */
  | 'wipe-failed';

export type PodSessionState =
  /** `outcome` says how the last attempt ended, so a reload does not hide the answer. */
  | { kind: 'disconnected'; outcome?: 'disconnected' | 'declined' }
  /** The app's own confirmation dialog is open and names the sign-in server. */
  | { kind: 'connecting'; issuer: string }
  /**
   * A pod window with a connect the person just approved. Nothing starts until they click.
   * `webId` is the profile they typed, when they typed one; `approved` is an address they allowed
   * after the sign-in was interrupted, so the click resumes it.
   */
  | { kind: 'ready-to-sign-in'; issuer: string; webId?: string; approved?: string; purpose?: OriginPurpose }
  /**
   * pod-auth needs to read `origin`, which this window may not contact yet. Nothing is sent
   * there until the person agrees in the app's dialog, which reloads the window. `phase`
   * says what was running: a sign-in (it has to be done again afterwards) or the restore of a
   * stored session (which is kept).
   */
  | {
      kind: 'needs-approval';
      origin: string;
      phase: 'sign-in' | 'restore';
      /** Why pod-auth needs it, as far as the page can tell: what the app's dialog will say. */
      purpose: OriginPurpose;
      /** Set after an Allow that changed nothing: `too-fast` (press Allow again) or `busy` (wait a moment). */
      wait?: 'too-fast' | 'busy';
      /** The profile the person typed, when they typed one. */
      webId?: string;
    }
  /**
   * pod-auth has the provider's sign-in page ready and asks the person before the system browser
   * opens: `provider` is the origin of that page, taken from the address pod-auth is about to
   * open, never from what was typed. `webId` is the profile they typed, when they typed one.
   */
  | { kind: 'confirm-provider'; provider: string; webId?: string }
  /**
   * `issuer` is the origin this window was entered for. `provider` is where the browser is, once it
   * is open, so a text never names the wrong address; it is absent while pod-auth is still reading.
   */
  | { kind: 'signing-in'; issuer: string; provider?: string }
  /**
   * `storageUnknown`: pod-auth found no storage for this WebID, so no pod request carries the
   * person's credentials (see `StorageUnknownReason`). Absent when it found one.
   */
  | { kind: 'connected'; webId: string; storageUnknown?: StorageUnknownReason }
  | { kind: 'leaving'; step: 'revoking' | 'clearing' | 'reloading' }
  /**
   * Disconnected on this device: the stored sign-in data is gone, but the provider could not
   * be told, so the session may stay valid there until it expires.
   */
  | { kind: 'signed-out-locally' }
  | { kind: 'error'; error: PodSessionErrorKind }
  | { kind: 'unsupported'; reason: UnsupportedReason };

/**
 * Why pod-auth found no storage for the signed-in WebID. `no-storage-declared`: the profile has
 * no `pim:storage` and the server that holds it declares none either. `profile-redirected`: the
 * profile was served from another address, which cannot speak for the WebID's storage.
 * `storage-unconfirmed`: what that server says about the storage contradicts itself, so pod-auth
 * did not guess. `discovery-failed`: that server could not be asked (no answer, or an error); the
 * next sign-in or restore asks again. `storage-ineligible`: the storage named is not one ArtCraft
 * may send credentials to (for example not HTTPS).
 */
export type StorageUnknownReason =
  | 'no-storage-declared'
  | 'profile-redirected'
  | 'storage-unconfirmed'
  | 'discovery-failed'
  | 'storage-ineligible';
