import { CloseButton } from "@storyteller/ui-close-button";
import { Modal } from "@storyteller/ui-modal";
import type { ReactNode } from "react";
import { SIGNED_OUT_DETAIL, SIGNED_OUT_TITLE } from "./podMessages";

/**
 * The header of the "My pod" view (source switch, title, controls, close) around its body. The
 * gallery draws it itself while the panel's code is loading or has failed to load, so that the
 * switch never disappears from under the person and the hosted view does not show through.
 */
export function PodPanelFrame({ sourceSwitch, controls, onClose, children }: { sourceSwitch: ReactNode; controls?: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <div className="relative flex h-full flex-col" data-pod-gallery>
      <div className="border-b border-ui-panel-border bg-ui-panel p-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-y-2">
          <div className="flex flex-wrap items-center gap-3 gap-y-1">
            {sourceSwitch}
            <h2 className="relative z-[51] text-lg font-semibold">My pod</h2>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {controls}
            <Modal.ExpandButton />
            <CloseButton onClick={onClose} className="relative z-[51]" />
          </div>
        </div>
      </div>
      {children}
    </div>
  );
}

/** A placeholder grid for while the pod's pictures are being listed. Decorative: hidden from readers. */
export function PodSkeleton({ columns }: { columns: number }) {
  return (
    <div className="grid gap-1.5 p-4" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }} aria-hidden="true" data-testid="pod-skeleton">
      {Array.from({ length: columns * 3 }, (_, index) => (
        <div key={index} className="aspect-square animate-pulse bg-white/[0.06]" />
      ))}
    </div>
  );
}

/**
 * The body of "My pod" while the session has ended: says so where the person is looking, and
 * offers the way back. The button only asks the app; the browser opens after later clicks.
 */
export function PodSignedOut({
  onSignInAgain,
  asking = false,
  problem = null,
  canPress = true,
}: {
  onSignInAgain: () => void;
  /** The app is asking in its dialog: the button waits and says so. */
  asking?: boolean;
  /** What came of the last press, when it did not lead to a sign-in. */
  problem?: string | null;
  /** False when pressing again cannot help: no button. */
  canPress?: boolean;
}) {
  return (
    <div className="flex h-64 items-center justify-center px-6" role="alert" data-testid="pod-signed-out">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center text-sm">
        <div className="text-base-fg/70">{SIGNED_OUT_TITLE}</div>
        <div className="text-xs text-base-fg/60">{SIGNED_OUT_DETAIL}</div>
        {/* Announced when it changes: the answer to a press is shown here, where the person is looking. */}
        <div role="status" aria-live="polite" className="text-xs text-amber-300" data-testid="pod-signed-out-status">
          {asking ? "Waiting for your answer in ArtCraft's dialog." : problem}
        </div>
        {/* No autofocus: a stray Enter must not start a sign-in. */}
        {(canPress || asking) && (
          <button
            type="button"
            className="rounded-[3px] bg-ui-controls px-3 py-1.5 text-sm font-medium text-base-fg hover:bg-ui-controls/80 disabled:opacity-60"
            onClick={onSignInAgain}
            disabled={asking}
          >
            Sign in again
          </button>
        )}
      </div>
    </div>
  );
}
