/** Why the feature is off. Closed set; the UI maps each to a sentence. */
export type UnsupportedReason =
  | 'insecure-context'
  | 'web-locks-missing'
  | 'web-locks-broken'
  | 'indexeddb-missing'
  | 'webcrypto-missing'
  | 'key-not-persistable';

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
  /** The stored sign-in data could not be deleted, or its deletion is still pending. */
  | 'wipe-failed';

export type PodSessionState =
  /** `outcome` says how the last attempt ended, so a reload does not hide the answer. */
  | { kind: 'disconnected'; outcome?: 'disconnected' | 'declined' }
  /** The app's own confirmation dialog is open and names the sign-in server. */
  | { kind: 'connecting'; issuer: string }
  /** A pod window with a connect the person just approved. Nothing starts until they click. */
  | { kind: 'ready-to-sign-in'; issuer: string }
  | { kind: 'signing-in'; issuer: string }
  | { kind: 'connected'; webId: string }
  | { kind: 'leaving'; step: 'revoking' | 'clearing' | 'reloading' }
  /**
   * Disconnected on this device: the stored sign-in data is gone, but the provider could not
   * be told, so the session may stay valid there until it expires.
   */
  | { kind: 'signed-out-locally' }
  | { kind: 'error'; error: PodSessionErrorKind }
  | { kind: 'unsupported'; reason: UnsupportedReason };
