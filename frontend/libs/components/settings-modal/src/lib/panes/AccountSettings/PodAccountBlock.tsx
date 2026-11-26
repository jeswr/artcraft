import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  ERROR_TEXT,
  type PodSession,
  type PodSessionErrorKind,
  type PodSessionState,
  STORAGE_UNKNOWN_TEXT,
  type StorageUnknownReason,
  UNSUPPORTED_TEXT,
  usePodSessionOrNull,
  usePodSessionState,
} from "@storyteller/pod-session";
import { describePause, PodLibraryMissingBlock, usePodMirrorSummary, usePodMirrorView } from "@storyteller/pod-mirror-ui";
import { Button } from "@storyteller/ui-button";
import { Input } from "@storyteller/ui-input";
import { PodGoneBlock } from "./PodGoneBlock";
import { PodImportBlock } from "./PodImportBlock";

/**
 * What connecting does in this build. Connecting copies new work to the pod; it does not move
 * anything: ArtCraft's hosted library stays the working library.
 */
const DISCLOSURE =
  "Connecting signs you in to your Solid pod provider and saves a copy of your new generations, uploads and edits to your pod, with the prompt and settings ArtCraft has for each. ArtCraft's servers still receive what you generate and upload. When you delete an item in ArtCraft while your pod is connected in this window, ArtCraft removes its pod copy too. An item deleted at any other time (in a window that is not in pod mode, or after your pod sign-in ended) keeps its pod copy, as does an item missing from ArtCraft for any other reason: when ArtCraft next checks your pod, this page tells you, so you can decide. Audio, scene files and files over 50 MB are not copied.";
const RESTART =
  "ArtCraft asks you to confirm the address in a separate dialog, then restarts this window in a restricted pod mode: usage analytics are off and the window can only reach your provider and ArtCraft's own services. Anything unsaved in this window is lost when it restarts.";

/** Settings block for the Solid pod session. Renders nothing without a session provider. */
export const PodAccountBlock = () => {
  const session = usePodSessionOrNull();
  if (!session) return null;
  return (
    <>
      <PodAccountBlockInner session={session} />
      <hr className="border-ui-panel-border" />
    </>
  );
};

const PodAccountBlockInner = ({ session }: { session: PodSession }) => {
  const state = usePodSessionState(session);
  // A window that may still hold sign-in data from an earlier session only finishes that.
  const finishing = session.finishing() && !session.inPodMode() && state.kind !== "leaving";

  useEffect(() => {
    void session.start();
  }, [session]);

  return (
    <section className="flex flex-col gap-3" aria-labelledby="pod-account-heading">
      <h3
        id="pod-account-heading"
        className="font-mono text-[11px] font-semibold uppercase tracking-[0.12em]"
      >
        Solid pod
      </h3>
      {/* A change that happens away from focus is announced here. */}
      <div role="status" aria-live="polite" className="text-sm text-base-fg/80">
        <StatusText state={state} podWindow={session.inPodMode()} finishing={finishing} />
      </div>
      {state.kind === "connected" && <PodMirrorStatus storageUnknown={state.storageUnknown} />}
      <PodControls session={session} state={state} />
      {!finishing && (
        <>
          <p className="text-xs text-base-fg/70">{DISCLOSURE}</p>
          <p className="text-xs text-base-fg/70">{RESTART}</p>
        </>
      )}
    </section>
  );
};

const hostOf = (webId: string): string => {
  try {
    return new URL(webId).origin;
  } catch {
    return webId;
  }
};

const allowLabel = (state: Extract<PodSessionState, { kind: "needs-approval" }>): string =>
  state.purpose === "sign-in" ? `Allow ${state.origin} as where I sign in` : `Allow ${state.origin}`;

/** What the person allowed before the window restarted, in the words of what it was for. */
const ApprovedText = ({ state }: { state: Extract<PodSessionState, { kind: "ready-to-sign-in" }> }) => {
  if (!state.approved) {
    return (
      <>
        You confirmed <span className="break-all font-medium">{state.issuer}</span>.
      </>
    );
  }
  const origin = <span className="break-all font-medium">{state.approved}</span>;
  switch (state.purpose) {
    case "sign-in":
      return <>You allowed {origin} as the place you sign in.</>;
    case "app-identity":
      return <>You allowed {origin}, where ArtCraft publishes its own identity document.</>;
    case "profile":
      return <>You allowed {origin} to be read for your profile.</>;
    default:
      return <>You allowed {origin}.</>;
  }
};

const WAIT_TEXT = {
  "too-fast": "That answer came too quickly to count as yours, so nothing changed. Press Allow again.",
  busy: "ArtCraft is not ready to ask again yet (a dialog is open, or it is waiting after a refusal). Wait a few seconds and press Allow again.",
} as const;

const NeedsApprovalText = ({ state }: { state: Extract<PodSessionState, { kind: "needs-approval" }> }) => {
  const origin = <span className="break-all font-medium">{state.origin}</span>;
  let body;
  if (state.phase === "restore") {
    body = (
      <>
        Reconnecting to your pod needs to read from {origin}, which this window is not allowed to contact yet. Your
        saved sign-in is kept. If you allow it, ArtCraft asks you to confirm in a separate dialog and reloads this
        window.
      </>
    );
  } else if (state.purpose === "sign-in") {
    body = (
      <>
        {state.webId ? (
          <>
            Your profile at <span className="break-all font-medium">{hostOf(state.webId)}</span> names {origin} as the
            place you sign in.
          </>
        ) : (
          <>Signing in needs {origin} as the place you sign in.</>
        )}{" "}
        This window is not allowed to contact it yet, and nothing was sent there. If you allow it, ArtCraft asks you to
        confirm in a separate dialog and restarts this window; your browser then opens at {origin} and asks you to sign
        in there, perhaps with your password. Only allow it if you recognise {origin} as your Solid provider.
      </>
    );
  } else if (state.purpose === "app-identity") {
    body = (
      <>
        Signing in needs to contact {origin}, where ArtCraft publishes its own identity document, which your provider
        reads to recognise ArtCraft. It is not where your pod or profile lives, and allowing it is normal when you sign
        in. Nothing was sent there yet. If you allow it, ArtCraft asks you to confirm in a separate dialog and restarts
        this window.
      </>
    );
  } else {
    body = (
      <>
        Signing in needs to read your WebID profile from {origin}, which this window is not allowed to contact yet.
        Nothing was sent there. If you allow it, ArtCraft asks you to confirm in a separate dialog and restarts this
        window; you then continue the sign-in. Only allow this address if it is where your profile lives.
      </>
    );
  }
  return (
    <>
      {body}
      {state.wait ? <span className="mt-1 block font-medium">{WAIT_TEXT[state.wait]}</span> : null}
    </>
  );
};

const StatusText = ({
  state,
  podWindow,
  finishing,
}: {
  state: PodSessionState;
  podWindow: boolean;
  finishing: boolean;
}) => {
  if (finishing) {
    return (
      <>
        Disconnecting did not finish. Sign-in data may still be stored on this computer, so ArtCraft keeps this window
        restricted (no analytics, no third-party scripts) until it is removed. Press Finish disconnecting to try again;
        if it keeps failing, quit and reopen ArtCraft and try once more.
      </>
    );
  }
  switch (state.kind) {
    case "unsupported":
      return <>Solid pod sign-in is not available: {UNSUPPORTED_TEXT[state.reason]}.</>;
    case "connected":
      return (
        <div className="flex flex-col gap-1">
          <span>Connected as</span>
          <span className="break-all text-base font-semibold" data-testid="pod-webid">
            {state.webId}
          </span>
          <span className="text-xs text-base-fg/70">
            If you do not recognise this WebID, choose Leave pod mode now.
          </span>
          {state.storageUnknown && (
            <span className="text-sm text-amber-300" data-testid="pod-storage-unknown">
              {STORAGE_UNKNOWN_TEXT[state.storageUnknown]}
            </span>
          )}
        </div>
      );
    case "ready-to-sign-in":
      return (
        <>
          {state.webId ? (
            <>
              You entered the WebID <span className="break-all font-medium">{state.webId}</span>.{" "}
            </>
          ) : null}
          <ApprovedText state={state} /> Nothing has started yet; continue when you are ready. Before your browser
          opens, ArtCraft shows you the address it will sign you in at.
        </>
      );
    case "needs-approval":
      return <NeedsApprovalText state={state} />;
    case "confirm-provider":
      return (
        <>
          {state.webId ? (
            <>
              Your profile is at <span className="break-all font-medium">{hostOf(state.webId)}</span>. It says you sign
              in at <span className="break-all font-semibold" data-testid="pod-provider">{state.provider}</span>.
            </>
          ) : (
            <>
              You will sign in at <span className="break-all font-semibold" data-testid="pod-provider">{state.provider}</span>.
            </>
          )}{" "}
          Your browser opens there and asks you to sign in, perhaps with your password. Nothing has opened yet. Only
          continue if you recognise that address as your Solid provider.
        </>
      );
    case "connecting":
      return (
        <>
          Waiting for you to confirm <span className="break-all font-medium">{state.issuer}</span> in the
          dialog.
        </>
      );
    case "signing-in":
      return state.provider ? (
        <>
          Waiting for your browser to finish signing in at{" "}
          <span className="break-all font-medium">{state.provider}</span>.
        </>
      ) : (
        <>Preparing your sign-in. Your browser has not opened yet.</>
      );
    case "leaving":
      return <>Disconnecting and removing your sign-in data from this computer.</>;
    case "signed-out-locally":
      return (
        <>
          Disconnected on this computer, but your provider could not be told. The session may stay valid
          there until it expires.
        </>
      );
    case "error":
      return <>{podWindow ? "Not connected. This window is in pod mode." : "Not connected."}</>;
    case "disconnected":
      if (state.outcome === "disconnected") {
        return <>Disconnected. Your sign-in data was removed from this computer.</>;
      }
      if (state.outcome === "declined") return <>Not connected. You declined the confirmation.</>;
      return <>{podWindow ? "Not connected. This window is in pod mode." : "Not connected."}</>;
  }
};

const PodControls = ({ session, state }: { session: PodSession; state: PodSessionState }) => {
  const podWindow = session.inPodMode();
  const error = state.kind === "error" ? state.error : undefined;
  if (session.finishing() && !podWindow && state.kind !== "leaving") {
    return (
      <div className="flex flex-col gap-2">
        {error && <ErrorText error={error} />}
        <div>
          <LeaveButton session={session} label="Finish disconnecting" />
        </div>
      </div>
    );
  }
  switch (state.kind) {
    case "ready-to-sign-in":
      return (
        <div className="flex gap-2">
          {/* No autofocus: a stray Enter must not start the sign-in. */}
          <Button onClick={() => void session.beginSignIn()}>Continue sign-in</Button>
          <LeaveButton session={session} />
        </div>
      );
    case "needs-approval":
      return (
        <div className="flex gap-2">
          <Button onClick={() => void session.approveOrigin()}>{allowLabel(state)}</Button>
          <LeaveButton session={session} />
        </div>
      );
    case "confirm-provider":
      return (
        <div className="flex gap-2">
          {/* No autofocus: a stray Enter must not open the browser. */}
          <Button onClick={() => session.openBrowser()}>Sign in at {state.provider}</Button>
          <Button variant="secondary" onClick={() => session.cancel()}>
            Cancel sign-in
          </Button>
          <LeaveButton session={session} />
        </div>
      );
    case "connecting":
    case "leaving":
      return null;
    case "signing-in":
      return (
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => session.cancel()}>
            Cancel sign-in
          </Button>
          <LeaveButton session={session} />
        </div>
      );
    case "connected":
      return <LeaveButton session={session} />;
    default:
      // A pod window offers leaving, from every state, and signing in again at its own address when
      // the session is gone; an ordinary window offers connecting.
      return podWindow ? (
        <div className="flex flex-col gap-2">
          {error && <ErrorText error={error} />}
          <div className="flex gap-2">
            {/* No autofocus: a stray Enter must not start a sign-in. */}
            {session.canSignInAgain() && <Button onClick={() => void session.signInAgain()}>Sign in again</Button>}
            {error && RETRYABLE.has(error) && (
              <Button variant="secondary" onClick={() => void session.retry()}>
                Try again
              </Button>
            )}
            <LeaveButton session={session} />
          </div>
        </div>
      ) : state.kind === "unsupported" ? null : (
        <ConnectForm session={session} error={error} />
      );
  }
};

/** Errors that left the stored session alone, so the restore can simply run again. */
const RETRYABLE: ReadonlySet<PodSessionErrorKind> = new Set(["origin-declined", "restore-failed"]);

const ErrorText = ({ error }: { error: PodSessionErrorKind }) => (
  <p id="pod-error" role="alert" className="text-sm text-red-300">
    {ERROR_TEXT[error]}
  </p>
);

const ConnectForm = ({ session, error }: { session: PodSession; error?: PodSessionErrorKind }) => {
  const [issuer, setIssuer] = useState("");
  const check = session.configCheck();
  const unavailable = check !== "ok";

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void session.connect(issuer);
  };

  return (
    <form className="flex flex-col gap-2" onSubmit={submit} noValidate>
      <Input
        id="pod-issuer"
        label="WebID or identity provider address"
        type="url"
        inputMode="url"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="https://login.example or https://pod.example/alice/profile/card#me"
        value={issuer}
        disabled={unavailable}
        isError={error === "invalid-issuer"}
        aria-invalid={error === "invalid-issuer"}
        aria-describedby={error ? "pod-error" : unavailable ? "pod-unavailable" : undefined}
        onChange={(e) => setIssuer(e.target.value)}
      />
      {error && <ErrorText error={error} />}
      {unavailable && (
        <p id="pod-unavailable" className="text-xs text-base-fg/70">
          {check === "invalid"
            ? ERROR_TEXT["invalid-config"]
            : ERROR_TEXT["not-configured"]}
        </p>
      )}
      <div>
        <Button type="submit" disabled={unavailable || issuer.trim().length === 0}>
          Connect
        </Button>
      </div>
    </form>
  );
};

/**
 * Leaves pod mode from any state. The window wipes its stored sign-in data first, then the
 * app is asked to leave; the button is disabled while that runs.
 */
const LeaveButton = ({ session, label }: { session: PodSession; label?: string }) => {
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const leave = async () => {
    setBusy(true);
    try {
      await session.leave();
    } finally {
      if (mounted.current) setBusy(false);
    }
  };
  return (
    <Button variant="destructive" disabled={busy} onClick={() => void leave()}>
      {label ?? (session.inPodMode() ? "Leave pod mode" : "Disconnect")}
    </Button>
  );
};

/**
 * How the copy to the pod is going: counts, why it is paused, and "Forget this account", which
 * deletes ArtCraft's local record of what was copied (never anything on the pod). Renders
 * nothing until the mirror exists, except the pause line while no storage is known (no mirror runs then).
 */
const STORAGE_UNKNOWN_PAUSE =
  "Copying to your pod is paused: ArtCraft cannot make requests to your pod as you, for the reason given above. Checking again here does not help; do what it says, then close and reopen ArtCraft.";

const PodMirrorStatus = ({ storageUnknown }: { storageUnknown?: StorageUnknownReason }) => {
  const view = usePodMirrorView();
  const summary = usePodMirrorSummary();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // While no storage is known the mirror does not run and nothing here can help: "Check again"
  // would be refused the same way. The reason above says what does (fix the profile, then reopen
  // ArtCraft), so this line points at it and offers no buttons.
  if (storageUnknown) {
    return (
      <div role="status" className="text-sm text-base-fg/80" data-testid="pod-mirror-status">
        <span data-testid="pod-mirror-paused">{STORAGE_UNKNOWN_PAUSE}</span>
      </div>
    );
  }
  if (!view || !summary) return null;
  if (view.unavailable) {
    return (
      <p role="status" className="text-sm text-amber-300" data-testid="pod-mirror-status">
        Copying to your pod is unavailable on this computer: the record ArtCraft keeps of what was copied could not be opened.
      </p>
    );
  }
  const { saved, pending, failed, skipped, removing } = summary.counts;
  const exposurePause =
    summary.paused === "exposed" || summary.paused === "exposure-unknown" || summary.paused === "storage-unsafe" || summary.paused === "storage-refused";
  const forget = async () => {
    setBusy(true);
    try {
      await view.forgetAccount();
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };
  return (
    <div className="flex flex-col gap-2" data-testid="pod-mirror-status">
      <p className="text-sm text-base-fg/80">
        Saved to pod: {saved}. Waiting or saving: {pending + removing}. Not saved: {failed}. Not copied: {skipped}.
      </p>
      {/* Only a change in what needs attention is announced, not every count. */}
      <div role="status" aria-live="polite" className="flex flex-col gap-1 text-sm text-base-fg/80">
        {summary.paused && summary.paused !== "stopped" && (
          <span data-testid="pod-mirror-paused">
            {describePause(summary.paused)}
          </span>
        )}
        {summary.paused === "exposure-unknown" && summary.exposureTarget && (
          <span data-testid="pod-mirror-unverified">
            Your pod does not let ArtCraft read its access rules, so this cannot be checked for {summary.exposureTarget}. If you know
            that only you can read it, confirm it below and ArtCraft will save copies there. It will not change any access rules.
          </span>
        )}
        {(summary.paused === "exposed" || summary.paused === "storage-unsafe") && summary.exposureTarget && <span>Checked: {summary.exposureTarget}</span>}
        {failed > 0 && <span data-testid="pod-mirror-failed">{failed} {failed === 1 ? "item was" : "items were"} not saved or removed.</span>}
      </div>
      <div className="flex flex-wrap gap-2">
        {exposurePause && (
          <Button variant="secondary" onClick={() => view.recheckExposure()}>
            Check again
          </Button>
        )}
        {summary.paused === "exposure-unknown" && summary.exposureTarget && (
          <Button variant="secondary" onClick={() => void view.confirmPrivate()}>
            Confirm this container is private
          </Button>
        )}
        {failed > 0 && (
          <Button variant="secondary" onClick={() => void view.retryAllFailed()}>
            Retry all failed
          </Button>
        )}
      </div>
      {summary.mediaHostBlocked && (
        <p role="status" className="text-sm text-amber-300" data-testid="pod-mirror-media-host">
          ArtCraft's media host cannot be reached from this app, so nothing can be copied right now. Items stay waiting and are tried again.
        </p>
      )}
      {/* Renders only when the pod check found much of the library missing; nothing was queued until the person presses Copy again. */}
      <PodLibraryMissingBlock />
      {summary.goneFromArtcraft > 0 && <PodGoneBlock count={summary.goneFromArtcraft} remove={() => view.removeGoneFromPod()} />}
      {view.import && <PodImportBlock controls={view.import} status={summary.import} engineStatus={summary.paused} />}
      {confirming ? (
        <div className="flex flex-col gap-2" role="group" aria-label="Confirm forgetting this account">
          <p className="text-xs text-base-fg/70">
            This deletes the record ArtCraft keeps on this computer of which items were copied to your pod. Nothing on your pod is
            deleted, and ArtCraft will no longer be able to remove those copies when you delete an item. Items you add from now on are
            copied; older items are not copied again.
          </p>
          <div className="flex gap-2">
            <Button variant="destructive" disabled={busy} onClick={() => void forget()}>
              Forget this account
            </Button>
            <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div>
          <Button variant="secondary" onClick={() => setConfirming(true)}>
            Forget this account
          </Button>
        </div>
      )}
    </div>
  );
};
