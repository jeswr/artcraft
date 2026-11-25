import { Button } from "@storyteller/ui-button";
import { useEffect, useRef, useState } from "react";

/**
 * Items ArtCraft no longer lists. Their copies stay on the pod until the person decides: nothing
 * is removed because of a lookup, only because of an explicit, confirmed choice here.
 */
export const PodGoneBlock = ({ count, remove }: { count: number; remove: () => Promise<number> }) => {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLDivElement>(null);
  const opened = useRef(false);
  const items = count === 1 ? "item was" : "items were";

  useEffect(() => {
    if (confirming) {
      opened.current = true;
      dialog.current?.focus();
    } else if (opened.current) {
      opened.current = false;
      trigger.current?.querySelector("button")?.focus();
    }
  }, [confirming]);

  const run = async () => {
    setBusy(true);
    try {
      await remove();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="pod-gone">
      <p role="status" aria-live="polite" className="text-sm text-base-fg/80">
        {count} {items} removed from ArtCraft but {count === 1 ? "is" : "are"} still in your pod.
      </p>
      {confirming ? (
        <div
          ref={dialog}
          tabIndex={-1}
          role="alertdialog"
          aria-modal="false"
          aria-label="Confirm removing copies from your pod"
          aria-describedby="pod-gone-confirm"
          className="flex flex-col gap-2"
        >
          <p id="pod-gone-confirm" className="text-xs text-base-fg/70">
            This deletes {count} {count === 1 ? "copy" : "copies"} from your pod. It cannot be undone, and it changes nothing in ArtCraft.
          </p>
          <div className="flex gap-2">
            <Button variant="destructive" disabled={busy} onClick={() => void run()}>
              Remove from my pod
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Keep them
            </Button>
          </div>
        </div>
      ) : (
        <div ref={trigger}>
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            Remove these from my pod
          </Button>
        </div>
      )}
    </div>
  );
};
