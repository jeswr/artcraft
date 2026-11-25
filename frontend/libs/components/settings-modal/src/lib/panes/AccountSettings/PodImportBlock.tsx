import type { ImportStatus, PauseReason } from "@storyteller/pod-mirror";
import { describePause, type PodImportControls } from "@storyteller/pod-mirror-ui";
import { Button } from "@storyteller/ui-button";
import { useEffect, useRef, useState } from "react";

/**
 * "Copy my existing library to my pod": an explicit, pausable, cancellable copy of everything
 * already in ArtCraft. It says what will happen before it starts; nothing begins on its own.
 */
export const PodImportBlock = ({ controls, status, engineStatus }: { controls: PodImportControls; status: ImportStatus; engineStatus: PauseReason | null }) => {
  const [asking, setAsking] = useState<{ total: number | null } | "loading" | null>(null);
  const [busy, setBusy] = useState(false);
  const active = status.state === "running" || status.state === "paused";
  const dialog = useRef<HTMLDivElement>(null);
  const stateLine = useRef<HTMLDivElement>(null);
  const opened = useRef(false);

  // Focus follows the confirmation: into it when it opens, to the status line when it closes.
  useEffect(() => {
    if (asking !== null && asking !== "loading") {
      opened.current = true;
      dialog.current?.focus();
    } else if (asking === null && opened.current) {
      opened.current = false;
      stateLine.current?.focus();
    }
  }, [asking]);

  const ask = async () => {
    setAsking("loading");
    const { total } = await controls.estimate().catch(() => ({ total: null }));
    setAsking({ total });
  };
  const begin = async (total: number | null) => {
    setBusy(true);
    try {
      await controls.start(total);
    } finally {
      setBusy(false);
      setAsking(null);
    }
  };
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" role="group" aria-labelledby="pod-import-heading" data-testid="pod-import">
      <h4 id="pod-import-heading" className="text-sm font-semibold">
        Copy my existing library to my pod
      </h4>
      {/* Announces what changed in kind (started, paused, finished), never each item. */}
      <div ref={stateLine} tabIndex={-1} role="status" aria-live="polite" className="text-sm text-base-fg/80" data-testid="pod-import-state">
        {stateText(status, engineStatus)}
      </div>
      {active && <Progress status={status} />}
      {!active && status.state !== "idle" && <Counts status={status} />}
      {asking === null && !active && (
        <div>
          <Button variant="secondary" onClick={() => void ask()}>
            {status.state === "done" ? "Copy my existing library again" : "Copy my existing library"}
          </Button>
        </div>
      )}
      {asking === "loading" && <p className="text-xs text-base-fg/70">Checking how many items you have.</p>}
      {asking !== null && asking !== "loading" && (
        <div
          ref={dialog}
          tabIndex={-1}
          role="alertdialog"
          aria-modal="false"
          aria-label="Confirm copying your existing library"
          aria-describedby="pod-import-disclosure"
          className="flex flex-col gap-2"
        >
          <p id="pod-import-disclosure" className="text-xs text-base-fg/70" data-testid="pod-import-disclosure">
            This copies {asking.total === null ? "all items in your ArtCraft library" : `the ${asking.total} items in your ArtCraft library`} to your
            pod. It can take a long time and uses storage on your pod. You can pause or cancel at any time, and every item stays in ArtCraft.
            Items already copied are not copied again.
          </p>
          <div className="flex gap-2">
            <Button disabled={busy} onClick={() => void begin(asking.total)}>
              Start copying
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setAsking(null)}>
              Not now
            </Button>
          </div>
        </div>
      )}
      {active && (
        <div className="flex gap-2">
          {status.state === "running" ? (
            <Button variant="secondary" disabled={busy} onClick={() => void run(() => controls.pause())}>
              Pause copying
            </Button>
          ) : (
            <Button variant="secondary" disabled={busy} onClick={() => void run(() => controls.resume())}>
              Resume copying
            </Button>
          )}
          <Button variant="secondary" disabled={busy} onClick={() => void run(() => controls.cancel())}>
            Cancel copying
          </Button>
        </div>
      )}
    </div>
  );
};

function stateText(status: ImportStatus, engine: PauseReason | null): string {
  switch (status.state) {
    case "running": {
      if (engine && engine !== "stopped") return `Copying your existing library is waiting. ${describePause(engine)}`;
      const waiting = status.pending;
      return status.pending > 0 && status.walked > 0 && status.total !== null && status.walked >= status.total
        ? `Finishing: ${waiting} ${waiting === 1 ? "item is" : "items are"} still being copied or waiting to try again.`
        : "Copying your existing library. You can keep using ArtCraft.";
    }
    case "paused":
      return status.pausedBy === "quota"
        ? "Paused: your pod says its storage is full. Free up space on your pod, then resume. Nothing was marked as failed."
        : "Paused. Resume when you are ready.";
    case "cancelled":
      return "Cancelled. Items already copied stay on your pod.";
    case "done":
      return `Finished. Saved ${status.saved}, not copied ${status.skipped}, not saved ${status.failed}. Items that were not saved are still only in ArtCraft.`;
    default:
      return "";
  }
}

const Progress = ({ status }: { status: ImportStatus }) => (
  <div className="flex flex-col gap-1">
    {status.total !== null ? (
      <progress
        className="w-full"
        aria-label="Items looked at in your existing library"
        value={Math.min(status.walked, status.total)}
        max={status.total}
      />
    ) : (
      <progress className="w-full" aria-label="Items looked at in your existing library" />
    )}
    <Counts status={status} />
  </div>
);

const Counts = ({ status }: { status: ImportStatus }) => (
  <p className="text-xs text-base-fg/70" data-testid="pod-import-counts">
    {status.total !== null ? `Looked at ${Math.min(status.walked, status.total)} of ${status.total}. ` : `Looked at ${status.walked}. `}
    Saved: {status.saved}. Waiting: {status.pending}. Not saved: {status.failed}. Not copied: {status.skipped}.
  </p>
);
