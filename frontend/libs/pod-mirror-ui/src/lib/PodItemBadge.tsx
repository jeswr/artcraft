import { CloudAlertIcon, CloudCheckIcon, CloudOffIcon, CloudUploadIcon, LoaderCircleIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { describePodState, type Tone } from './messages.js';
import { usePodItemState, usePodMirrorView } from './view.js';

const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-green-300',
  busy: 'text-white',
  problem: 'text-amber-300',
  muted: 'text-white/70',
};

/**
 * A small per-item indicator for a gallery tile: saved, saving, not saved (with a retry button
 * when retrying can help). Renders nothing without a connected pod or for an item the mirror
 * has no record of. The meaning is in the icon shape and the accessible name, not in colour.
 */
export function PodItemBadge({ token, className }: { token: string; className?: string }) {
  const view = usePodMirrorView();
  const state = usePodItemState(token);
  if (!view || !state) return null;
  const text = describePodState(state);
  const icon = iconFor(state.kind);
  const box = `flex h-5 w-5 items-center justify-center bg-black/50 backdrop-blur-lg ${TONE_CLASS[text.tone]} ${className ?? ''}`;
  if (text.retryable) {
    return (
      <button
        type="button"
        className={`${box} cursor-pointer pointer-events-auto`}
        aria-label={`${text.label}. Retry`}
        title={`${text.label}. Retry`}
        onPointerDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          void view.retry(token);
        }}
      >
        {icon}
      </button>
    );
  }
  return (
    <span role="img" className={`${box} pointer-events-auto`} aria-label={text.label} title={text.label}>
      {icon}
    </span>
  );
}

function iconFor(kind: string): ReactNode {
  const cls = 'text-[10px]';
  if (kind === 'saved') return <CloudCheckIcon className={cls} aria-hidden="true" />;
  if (kind === 'pending' || kind === 'removing') {
    return <LoaderCircleIcon className={`${cls} motion-safe:animate-spin`} aria-hidden="true" />;
  }
  if (kind === 'skipped') return <CloudOffIcon className={cls} aria-hidden="true" />;
  if (kind === 'failed' || kind === 'remove-failed') return <CloudAlertIcon className={cls} aria-hidden="true" />;
  return <CloudUploadIcon className={cls} aria-hidden="true" />;
}

/** The same state as a line of text for a detail view, with a retry button when it can help. */
export function PodItemStatusRow({ token }: { token: string | undefined }) {
  const view = usePodMirrorView();
  const state = usePodItemState(token);
  if (!view || !token || !state) return null;
  const text = describePodState(state);
  return (
    <div className="mt-3 flex items-center gap-2 text-sm text-white/80" data-testid="pod-item-status">
      <span className={TONE_CLASS[text.tone]}>{iconFor(state.kind)}</span>
      <span>{text.label}</span>
      {text.retryable && (
        <button
          type="button"
          className="ml-auto underline underline-offset-2 hover:text-white"
          onClick={() => void view.retry(token)}
        >
          Retry
        </button>
      )}
    </div>
  );
}
