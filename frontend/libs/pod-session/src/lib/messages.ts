import type { PodSessionErrorKind, PodSessionState, StorageUnknownReason, UnsupportedReason } from './state.js';

/** One sentence for each closed reason. No message carries a host's text, token or URL. */
export const UNSUPPORTED_TEXT: Record<UnsupportedReason, string> = {
  'insecure-context': 'this window is not a secure context',
  'web-locks-missing': 'this webview has no Web Locks',
  'web-locks-broken': 'this webview does not enforce Web Locks',
  'indexeddb-missing': 'this webview has no IndexedDB',
  'webcrypto-missing': 'this webview has no Web Crypto',
  'key-not-persistable': 'this webview cannot keep a sign-in key safely',
};

export const ERROR_TEXT: Record<PodSessionErrorKind, string> = {
  'invalid-issuer':
    'Enter your WebID (for example https://id.example/alice/profile/card#me) or the address of your identity provider (for example https://login.example), with no user name, password or query. Host names with non-English letters (internationalised names) are not supported yet.',
  'invalid-config': 'Solid pod sign-in is set up incorrectly in this build, so it was not started.',
  'not-configured': 'Solid pod sign-in is not set up in this build yet.',
  'policy-not-applied':
    'Sign-in was stopped because this window could not confirm its network restrictions. Restart ArtCraft and try again.',
  'window-not-clean': 'Sign-in was stopped because this window is not isolated. Restart ArtCraft and try again.',
  'request-failed': 'ArtCraft could not change the window mode. Try again.',
  'browser-open-failed': 'ArtCraft could not open your browser.',
  'sign-in-timed-out': 'Sign-in took too long and was stopped. Try again.',
  'sign-in-failed': 'Sign-in did not finish. Check the address and try again.',
  'restore-failed': 'ArtCraft could not restore your previous sign-in. You can try again, sign in again or leave pod mode.',
  'session-ended':
    'Your pod sign-in has ended and could not be renewed without you, so ArtCraft stopped using your pod. Your browser was not opened. Choose Sign in again to continue, or leave pod mode.',
  'sign-in-again-wait': 'ArtCraft is not ready to ask again yet (a dialog is open, or it is waiting after a refusal). Wait a few seconds and choose Sign in again.',
  'sign-in-again-limit': 'ArtCraft has asked to sign you in again as many times as it does in one run. Quit and reopen ArtCraft, or leave pod mode and connect again.',
  'origin-declined':
    'ArtCraft was not allowed to connect to an address your profile needs, so your pod is not connected. Leave pod mode and connect again to be asked again, or try again.',
  'origin-limit':
    'ArtCraft has already asked about as many addresses as one pod-mode session allows. Leave pod mode and connect again to start over.',
  'approval-too-fast': 'That answer came too quickly to be sure it was yours, so nothing changed. Wait a few seconds and try again.',
  'invalid-response': 'ArtCraft could not read the profile or provider information it needed, so it did not sign in.',
  'wipe-failed':
    'ArtCraft could not finish removing your sign-in data from this computer, so this window stays restricted. Try again; if it keeps failing, quit and reopen ArtCraft first.',
};

/**
 * Why a connected session cannot make pod requests as the person: pod-auth found no storage for
 * the WebID, so it sends no credentials to any pod and every request reaches the pod as nobody.
 * Each sentence says why and what the person can do.
 */
export const STORAGE_UNKNOWN_TEXT: Record<StorageUnknownReason, string> = {
  'no-storage-declared':
    "ArtCraft cannot make requests to your pod as you: your profile does not say where your pod is (it has no storage entry), and ArtCraft could not confirm it from the server that holds your profile. Your pod sees ArtCraft's requests as coming from nobody, so nothing can be read from it or saved to it as you. Add your pod's address to your profile as its storage, then close and reopen ArtCraft.",
  'profile-redirected':
    "ArtCraft cannot make requests to your pod as you: your profile does not say where your pod is, and it was served from a different address than your WebID, which cannot speak for your pod. Your pod sees ArtCraft's requests as coming from nobody. Add your pod's address to your profile as its storage, then close and reopen ArtCraft.",
  'storage-unconfirmed':
    "ArtCraft cannot make requests to your pod as you: your profile does not say where your pod is, and what the server that holds your profile says about it does not add up, so ArtCraft did not guess. Your pod sees ArtCraft's requests as coming from nobody. Add your pod's address to your profile as its storage, then close and reopen ArtCraft.",
  'discovery-failed':
    "ArtCraft cannot make requests to your pod as you for now: your profile does not say where your pod is, and the server that holds your profile could not be asked (it did not answer, or reported an error). Your pod sees ArtCraft's requests as coming from nobody. Close and reopen ArtCraft to try again, or add your pod's address to your profile as its storage.",
  'server-storage-ineligible':
    "ArtCraft cannot make requests to your pod as you: your profile does not say where your pod is, and the server that holds your profile points to a pod that is not one ArtCraft sends your sign-in to (for example, it does not use HTTPS). Your pod sees ArtCraft's requests as coming from nobody. Add your pod's address to your profile as its storage, then close and reopen ArtCraft.",
  'storage-ineligible':
    "ArtCraft cannot make requests to your pod as you: the pod your profile names is not one ArtCraft sends your sign-in to (for example, it does not use HTTPS). Your pod sees ArtCraft's requests as coming from nobody. Check the storage address in your profile, then close and reopen ArtCraft.",
};

export type Notice = { level: 'success' | 'error'; message: string };

/**
 * A short notice for a state change the person may not be looking at: the window is rebuilt
 * between steps, so the answer must not depend on the Settings pane being open.
 */
export function noticeFor(previous: PodSessionState | null, next: PodSessionState): Notice | null {
  if (previous?.kind === next.kind && JSON.stringify(previous) === JSON.stringify(next)) return null;
  switch (next.kind) {
    case 'connected':
      return previous?.kind === 'connected' ? null : { level: 'success', message: 'Connected to your Solid pod.' };
    case 'disconnected':
      if (next.outcome === 'disconnected') {
        return { level: 'success', message: 'Disconnected. Your Solid pod sign-in data was removed from this computer.' };
      }
      return null;
    case 'signed-out-locally':
      return {
        level: 'error',
        message:
          'Disconnected on this computer, but your provider could not be told. The session may stay valid there until it expires.',
      };
    case 'error':
      return { level: 'error', message: ERROR_TEXT[next.error] };
    default:
      return null;
  }
}
