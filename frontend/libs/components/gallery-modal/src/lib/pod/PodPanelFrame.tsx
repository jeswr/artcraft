import { CloseButton } from "@storyteller/ui-close-button";
import { Modal } from "@storyteller/ui-modal";
import type { ReactNode } from "react";

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
