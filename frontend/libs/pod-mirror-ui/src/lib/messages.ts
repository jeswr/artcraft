import type { FailureReason, ItemState, PauseReason, SkipReason } from '@storyteller/pod-mirror';

export type Tone = 'ok' | 'busy' | 'problem' | 'muted';

export interface PodStateText {
  /** The accessible name: starts with what the indicator says, so a visible label can match it. */
  label: string;
  tone: Tone;
  /** True when pressing retry makes sense. */
  retryable: boolean;
}

const FAILURES: Record<FailureReason, string> = {
  conflict: 'a different file already has this name in your pod',
  forbidden: 'your pod refused the write',
  unsupported: 'the file type is not supported',
  exposed: 'your pod library can be read by others',
  'invalid-description': 'the description could not be written',
  'bytes-unavailable': 'the file could not be downloaded',
  'cdn-blocked': 'the download was blocked before ArtCraft could read it',
  'hosted-unavailable': 'ArtCraft could not be reached',
  offline: 'you are offline',
  store: 'your pod could not save it',
  unexpected: 'something went wrong',
};

const SKIPS: Record<SkipReason, string> = {
  'audio-unsupported': 'audio is not supported yet',
  scene: 'scene files are not copied',
  intermediate: 'it is a working file',
  'unsupported-type': 'this file type is not supported',
  'too-large': 'the file is larger than 50 MB, the most ArtCraft copies to a pod',
  'too-large-for-pod': 'your pod refused it for its size',
  'bad-date': 'ArtCraft could not read when it was made',
  'hosted-deleted': 'it was already deleted',
};

const PAUSES: Record<PauseReason, string> = {
  offline: 'waiting for a connection',
  session: 'waiting for the pod to reconnect',
  exposed: 'your pod library can be read by others',
  'exposure-unknown': 'ArtCraft could not confirm that your pod library is private',
  'store-unavailable': 'waiting for your pod',
  stopped: 'copying is not running',
};

/**
 * What one item's state says. While the mirror is paused, an item that is waiting says so
 * instead of "Saving": nothing is being saved.
 */
export function describePodState(state: ItemState, paused: PauseReason | null = null): PodStateText {
  switch (state.kind) {
    case 'saved':
      return { label: 'Saved to pod', tone: 'ok', retryable: false };
    case 'pending':
      if (paused) return { label: `Paused, not yet saved to pod: ${PAUSES[paused]}`, tone: 'muted', retryable: false };
      if (state.lastError) return { label: `Will try again to save to pod: ${FAILURES[state.lastError]}`, tone: 'muted', retryable: false };
      return { label: 'Saving to pod', tone: 'busy', retryable: false };
    case 'failed':
      return { label: `Not saved to pod: ${FAILURES[state.reason]}`, tone: 'problem', retryable: true };
    case 'skipped':
      return { label: `Not saved to pod: ${SKIPS[state.reason]}`, tone: 'muted', retryable: state.reason === 'bad-date' };
    case 'removing':
      if (paused) return { label: `Paused, not yet removed from pod: ${PAUSES[paused]}`, tone: 'muted', retryable: false };
      return { label: 'Removing from pod', tone: 'busy', retryable: false };
    case 'remove-failed':
      return { label: `Not removed from pod: ${FAILURES[state.reason]}`, tone: 'problem', retryable: true };
  }
}

/** The sentence for a pause, as the settings line shows it. */
export function describePause(reason: PauseReason): string {
  switch (reason) {
    case 'exposed':
      return 'Paused: your pod library can be read by others. Make it private, then check again.';
    case 'exposure-unknown':
      return 'Paused: ArtCraft could not confirm that your pod library is private.';
    case 'stopped':
      return 'Not running.';
    default:
      return `Paused: ${PAUSES[reason]}.`;
  }
}
