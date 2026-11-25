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
  'too-large': 'the file is too large',
  unsupported: 'the file type is not supported',
  exposed: 'your pod library can be read by others',
  'invalid-description': 'the description could not be written',
  'bytes-unavailable': 'the file could not be downloaded',
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
  'hosted-deleted': 'it was already deleted',
};

const PAUSES: Record<PauseReason, string> = {
  offline: 'Waiting for a connection.',
  session: 'Waiting for the pod to reconnect.',
  exposed: 'Paused: your pod library can be read by others. Make it private, then retry.',
  'exposure-unknown': 'Paused: ArtCraft could not confirm your pod library is private. Check it, then retry.',
  'store-unavailable': 'Waiting for your pod.',
  stopped: 'Not running.',
};

export function describePodState(state: ItemState): PodStateText {
  switch (state.kind) {
    case 'saved':
      return { label: 'Saved to pod', tone: 'ok', retryable: false };
    case 'pending':
      return { label: 'Saving to pod', tone: 'busy', retryable: false };
    case 'failed':
      return { label: `Not saved to pod: ${FAILURES[state.reason]}`, tone: 'problem', retryable: true };
    case 'skipped':
      return { label: `Not saved to pod: ${SKIPS[state.reason]}`, tone: 'muted', retryable: false };
    case 'removing':
      return { label: 'Removing from pod', tone: 'busy', retryable: false };
    case 'remove-failed':
      return { label: `Not removed from pod: ${FAILURES[state.reason]}`, tone: 'problem', retryable: true };
  }
}

export function describePause(reason: PauseReason): string {
  return PAUSES[reason];
}
