import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  ERROR_TEXT,
  type PodSession,
  type PodSessionErrorKind,
  type PodSessionState,
  UNSUPPORTED_TEXT,
  usePodSessionOrNull,
  usePodSessionState,
} from "@storyteller/pod-session";
import { Button } from "@storyteller/ui-button";
import { Input } from "@storyteller/ui-input";

/**
 * What connecting does in this build, and nothing more. Copying work to the pod is not built
 * yet, so nothing here promises it.
 */
const DISCLOSURE =
  "Connecting signs you in to your Solid pod provider, so ArtCraft can reach your pod. In this version ArtCraft does not copy any of your work to your pod; that arrives in a later step. ArtCraft's servers still receive what you generate and upload.";
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
    return <>Disconnecting did not finish. Sign-in data may still be stored on this computer.</>;
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
        </div>
      );
    case "ready-to-sign-in":
      return (
        <>
          You confirmed <span className="break-all font-medium">{state.issuer}</span>. Nothing has
          started yet; continue when you are ready.
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
      return (
        <>
          Waiting for your browser to finish signing in at{" "}
          <span className="break-all font-medium">{state.issuer}</span>.
        </>
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
      // A pod window offers leaving, from every state; an ordinary window offers connecting.
      return podWindow ? (
        <div className="flex flex-col gap-2">
          {error && <ErrorText error={error} />}
          <div>
            <LeaveButton session={session} />
          </div>
        </div>
      ) : state.kind === "unsupported" ? null : (
        <ConnectForm session={session} error={error} />
      );
  }
};

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
        label="Identity provider address"
        type="url"
        inputMode="url"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="https://login.example"
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
