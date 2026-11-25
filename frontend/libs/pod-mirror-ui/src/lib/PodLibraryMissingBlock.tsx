import { useState } from 'react';
import { describeLibraryMissing } from './messages.js';
import { usePodMirrorSummary, usePodMirrorView } from './view.js';

/**
 * Shown when the pod check found much of the library missing from the pod. Nothing was queued
 * on that evidence alone: the person decides, with "Copy again". Renders nothing otherwise.
 */
export function PodLibraryMissingBlock() {
  const view = usePodMirrorView();
  const summary = usePodMirrorSummary();
  const [busy, setBusy] = useState(false);
  const found = summary?.libraryMissing;
  if (!view || !found) return null;
  const copyAgain = view.copyAgain;
  return (
    <div className="flex flex-col gap-2" data-testid="pod-library-missing">
      <p role="status" aria-live="polite" className="text-sm text-base-fg/80">
        {describeLibraryMissing(found)}
      </p>
      {copyAgain && (
        <div>
          <button
            type="button"
            className="rounded-md bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20 disabled:opacity-50"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void copyAgain().finally(() => setBusy(false));
            }}
          >
            Copy again
          </button>
        </div>
      )}
    </div>
  );
}
