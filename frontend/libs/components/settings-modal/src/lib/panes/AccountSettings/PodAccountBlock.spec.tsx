import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import {
  type ConfigCheck,
  ERROR_TEXT,
  type PodSession,
  PodSessionProvider,
  type PodSessionErrorKind,
  type PodSessionState,
} from "@storyteller/pod-session";
import { afterEach, expect, it, vi } from "vitest";
import type { MirrorSummary } from "@storyteller/pod-mirror";
import { type PodMirrorView, PodMirrorViewProvider } from "@storyteller/pod-mirror-ui";
import { PodAccountBlock } from "./PodAccountBlock";

const WEBID = "https://pod.example/alice/profile/card#me";

afterEach(cleanup);

function fakeSession(initial: PodSessionState, options: { podWindow?: boolean; config?: ConfigCheck; finishing?: boolean } = {}) {
  let state = initial;
  const listeners = new Set<(s: PodSessionState) => void>();
  const session = {
    getState: () => state,
    subscribe: (l: (s: PodSessionState) => void) => {
      listeners.add(l);
      return () => void listeners.delete(l);
    },
    start: vi.fn(async () => state),
    connect: vi.fn(async () => undefined),
    beginSignIn: vi.fn(async () => undefined),
    finishing: () => options.finishing ?? false,
    cancel: vi.fn(),
    leave: vi.fn(async () => undefined),
    getFetch: () => null,
    inPodMode: () => options.podWindow ?? false,
    configCheck: () => options.config ?? "ok",
  } satisfies PodSession;
  return {
    session,
    set(next: PodSessionState) {
      state = next;
      act(() => listeners.forEach((l) => l(state)));
    },
  };
}

function renderBlock(initial: PodSessionState, options: { podWindow?: boolean; config?: ConfigCheck; finishing?: boolean } = {}) {
  const fake = fakeSession(initial, options);
  render(
    <PodSessionProvider session={fake.session} startNow={false}>
      <PodAccountBlock />
    </PodSessionProvider>,
  );
  return fake;
}

it("renders nothing without a session provider", () => {
  const { container } = render(<PodAccountBlock />);
  expect(container.textContent).toBe("");
});

it("connects from the keyboard with the typed address", async () => {
  const user = userEvent.setup();
  const { session } = renderBlock({ kind: "disconnected" });
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Identity provider address" }));
  expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
  await user.keyboard("https://login.example{Enter}");
  expect(session.connect).toHaveBeenCalledWith("https://login.example");
});

it("tells the truth about this build: new work is copied to the pod, servers still see it, deletes pair, a restart loses unsaved work", () => {
  renderBlock({ kind: "disconnected" });
  const text = document.body.textContent ?? "";
  expect(text).toMatch(/saves a copy of your new generations, uploads and edits to your pod/);
  expect(text).toMatch(/ArtCraft's servers still receive what you generate and upload/);
  expect(text).toMatch(/When you delete an item in ArtCraft, ArtCraft removes its pod copy too/);
  expect(text).toMatch(/Audio, scene files and files over 50 MB are not copied/);
  expect(text).toMatch(/its copy stays on your pod and this page tells you/);
  expect(text).toMatch(/Anything unsaved in this window is lost/);
  expect(text).not.toMatch(/does not copy any of your work/);
});

it("shows no copy status or forget button without a mirror, even when connected", () => {
  renderBlock({ kind: "connected", webId: WEBID });
  expect(screen.queryByTestId("pod-mirror-status")).toBeNull();
  expect(screen.queryByRole("button", { name: "Forget this account" })).toBeNull();
});

it("announces an invalid address in text and ties it to the field", () => {
  renderBlock({ kind: "error", error: "invalid-issuer" });
  const alert = screen.getByRole("alert");
  const field = screen.getByRole("textbox", { name: "Identity provider address" });
  expect(field.getAttribute("aria-invalid")).toBe("true");
  expect(field.getAttribute("aria-describedby")).toBe(alert.id);
  expect(alert.textContent).toBe(ERROR_TEXT["invalid-issuer"]);
});

it("explains why the feature is off and offers no form in an ordinary window", () => {
  renderBlock({ kind: "unsupported", reason: "web-locks-missing" });
  expect(screen.getByRole("status").textContent).toMatch(/not available.*Web Locks/);
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button")).toBeNull();
});

it("offers leaving even when the browser is unsupported, if the window is already in pod mode", async () => {
  const user = userEvent.setup();
  const { session } = renderBlock({ kind: "unsupported", reason: "web-locks-missing" }, { podWindow: true });
  await user.click(screen.getByRole("button", { name: "Leave pod mode" }));
  expect(session.leave).toHaveBeenCalledTimes(1);
});

it.each([
  ["a placeholder client", "not-configured", /not set up in this build/],
  ["an invalid config", "invalid", /set up incorrectly/],
] as const)("disables Connect for %s", (_name, config, text) => {
  renderBlock({ kind: "disconnected" }, { config });
  expect((screen.getByRole("textbox") as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Connect" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(text)).toBeTruthy();
});

it("shows the issuer being confirmed in the app's dialog and offers no buttons", () => {
  renderBlock({ kind: "connecting", issuer: "https://login.example" });
  expect(screen.getByRole("status").textContent).toContain("https://login.example");
  expect(screen.queryByRole("button")).toBeNull();
});

it("lets the person cancel the wait for the browser or leave", async () => {
  const user = userEvent.setup();
  const { session } = renderBlock({ kind: "signing-in", issuer: "https://login.example" }, { podWindow: true });
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  expect(session.cancel).toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Leave pod mode" }));
  expect(session.leave).toHaveBeenCalledTimes(1);
});

it("shows the WebID once connected and leaves", async () => {
  const user = userEvent.setup();
  const fake = renderBlock({ kind: "connected", webId: WEBID }, { podWindow: true });
  expect(screen.getByRole("status").textContent).toContain(WEBID);
  await user.click(screen.getByRole("button", { name: "Leave pod mode" }));
  expect(fake.session.leave).toHaveBeenCalledTimes(1);
});

it.each([
  ["a restore failure", { kind: "error", error: "restore-failed" }],
  ["a wipe failure", { kind: "error", error: "wipe-failed" }],
  ["a refused window", { kind: "error", error: "policy-not-applied" }],
  ["nothing connected", { kind: "disconnected" }],
] as const)("offers Leave pod mode in a pod window after %s", async (_name, state) => {
  const user = userEvent.setup();
  const fake = renderBlock(state as PodSessionState, { podWindow: true });
  expect(screen.queryByRole("textbox")).toBeNull();
  if (state.kind === "error") {
    expect(screen.getByRole("alert").textContent).toBe(ERROR_TEXT[state.error as PodSessionErrorKind]);
  }
  await user.click(screen.getByRole("button", { name: "Leave pod mode" }));
  expect(fake.session.leave).toHaveBeenCalledTimes(1);
});

it("says a disconnect is in progress and offers nothing to press", () => {
  renderBlock({ kind: "leaving", step: "clearing" }, { podWindow: true });
  expect(screen.getByRole("status").textContent).toMatch(/removing your sign-in data/);
  expect(screen.queryByRole("button")).toBeNull();
});

it("shows the confirmation after the window came back, in text, without hunting", () => {
  renderBlock({ kind: "disconnected", outcome: "disconnected" });
  expect(screen.getByRole("status").textContent).toMatch(/Disconnected. Your sign-in data was removed/);
});

it("says plainly when the provider could not be told, and still offers Connect", () => {
  renderBlock({ kind: "signed-out-locally" });
  expect(screen.getByRole("status").textContent).toMatch(/your provider could not be told/);
  expect(screen.getByRole("button", { name: "Connect" })).toBeTruthy();
});

it("says the person declined", () => {
  renderBlock({ kind: "disconnected", outcome: "declined" });
  expect(screen.getByRole("status").textContent).toMatch(/You declined/);
});

it("starts the session once when mounted", () => {
  const { session } = renderBlock({ kind: "disconnected" });
  expect(session.start).toHaveBeenCalledTimes(1);
});

it("waits for a click after a confirmed connect, with no autofocus", async () => {
  const user = userEvent.setup();
  const { session } = renderBlock({ kind: "ready-to-sign-in", issuer: "https://login.example" }, { podWindow: true });
  const button = screen.getByRole("button", { name: "Continue sign-in" });
  expect(document.activeElement).not.toBe(button);
  expect(document.body.textContent).toMatch(/Nothing has started yet/);
  expect(session.beginSignIn).not.toHaveBeenCalled();
  await user.click(button);
  expect(session.beginSignIn).toHaveBeenCalledTimes(1);
});

it("shows the connected WebID prominently with a leave hint", () => {
  renderBlock({ kind: "connected", webId: WEBID }, { podWindow: true });
  expect(screen.getByTestId("pod-webid").textContent).toBe(WEBID);
  expect(document.body.textContent).toMatch(/do not recognise this WebID/);
});

it("offers only finishing the disconnect in a finishing window", async () => {
  const user = userEvent.setup();
  const { session } = renderBlock({ kind: "error", error: "wipe-failed" }, { finishing: true });
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
  expect(document.body.textContent).not.toMatch(/does not copy any of your work/);
  await user.click(screen.getByRole("button", { name: "Finish disconnecting" }));
  expect(session.leave).toHaveBeenCalledTimes(1);
});

function renderWithMirror(summary: MirrorSummary, overrides: Partial<PodMirrorView> = {}) {
  const view: PodMirrorView = {
    stateOf: () => undefined,
    summary: () => summary,
    subscribe: () => () => undefined,
    retry: async () => undefined,
    retryAllFailed: vi.fn(async () => 1),
    recheckExposure: vi.fn(),
    confirmPrivate: vi.fn(async () => true),
    forgetAccount: vi.fn(async () => undefined),
    removeGoneFromPod: vi.fn(async () => 2),
    ...overrides,
  };
  const fake = fakeSession({ kind: "connected", webId: WEBID });
  render(
    <PodSessionProvider session={fake.session} startNow={false}>
      <PodMirrorViewProvider view={view}>
        <PodAccountBlock />
      </PodMirrorViewProvider>
    </PodSessionProvider>,
  );
  return view;
}

const SUMMARY: MirrorSummary = { version: 1, running: true, paused: null, exposureTarget: null, counts: { saved: 4, pending: 2, failed: 1, skipped: 3, removing: 0 }, goneFromArtcraft: 0, mediaHostBlocked: false };
const POD_LIBRARY = "https://pod.example/alice/creative-assets/";

it("shows how the copy is going, in words", () => {
  renderWithMirror(SUMMARY);
  expect(screen.getByTestId("pod-mirror-status").textContent).toMatch(/Saved to pod: 4\. Waiting or saving: 2\. Not saved: 1\. Not copied: 3\./);
  expect(screen.queryByTestId("pod-mirror-paused")).toBeNull();
});

it("announces what needs attention, not the counts", () => {
  renderWithMirror(SUMMARY);
  const live = within(screen.getByTestId("pod-mirror-status")).getByRole("status");
  expect(live.textContent).toMatch(/1 item was not saved or removed/);
  expect(live.textContent).not.toMatch(/Saved to pod/);
});

it("retries every failed item from one button", async () => {
  const user = userEvent.setup();
  const view = renderWithMirror(SUMMARY);
  await user.click(screen.getByRole("button", { name: "Retry all failed" }));
  expect(view.retryAllFailed).toHaveBeenCalledTimes(1);
});

it("offers no retry-all when nothing failed", () => {
  renderWithMirror({ ...SUMMARY, counts: { ...SUMMARY.counts, failed: 0 } });
  expect(screen.queryByRole("button", { name: "Retry all failed" })).toBeNull();
});

it("says why copying is paused when the pod library is readable by others, and checks again on request", async () => {
  const user = userEvent.setup();
  const view = renderWithMirror({ ...SUMMARY, paused: "exposed", exposureTarget: POD_LIBRARY });
  expect(screen.getByTestId("pod-mirror-paused").textContent).toMatch(/can be read by others/);
  expect(screen.queryByRole("button", { name: /Confirm this container is private/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Check again" }));
  expect(view.recheckExposure).toHaveBeenCalledTimes(1);
});

it("names what could not be verified and lets the person confirm the container is private", async () => {
  const user = userEvent.setup();
  const view = renderWithMirror({ ...SUMMARY, paused: "exposure-unknown", exposureTarget: POD_LIBRARY });
  expect(screen.getByTestId("pod-mirror-unverified").textContent).toContain(POD_LIBRARY);
  await user.click(screen.getByRole("button", { name: "Confirm this container is private" }));
  expect(view.confirmPrivate).toHaveBeenCalledTimes(1);
  expect(view.recheckExposure).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
});

it("says copying is unavailable when the local record cannot be opened", () => {
  renderWithMirror(SUMMARY, { unavailable: true });
  expect(screen.getByTestId("pod-mirror-status").textContent).toMatch(/unavailable on this computer/);
  expect(screen.queryByRole("button", { name: "Forget this account" })).toBeNull();
});

it("forgets the account only after a confirmation, and cancel does nothing", async () => {
  const user = userEvent.setup();
  const { forgetAccount: forget } = renderWithMirror(SUMMARY);
  await user.click(screen.getByRole("button", { name: "Forget this account" }));
  expect(forget).not.toHaveBeenCalled();
  expect(document.body.textContent).toMatch(/Nothing on your pod is deleted/);
  expect(document.body.textContent).toMatch(/no longer be able to remove those copies/);
  await user.click(screen.getByRole("button", { name: "Cancel" }));
  expect(forget).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Forget this account" }));
  await user.click(within(screen.getByRole("group", { name: "Confirm forgetting this account" })).getByRole("button", { name: "Forget this account" }));
  expect(forget).toHaveBeenCalledTimes(1);
});
it("says items gone from ArtCraft are still in the pod, and removes them only after a confirmed choice", async () => {
  const user = userEvent.setup();
  const view = renderWithMirror({ ...SUMMARY, goneFromArtcraft: 2 });
  expect(screen.getByTestId("pod-gone").textContent).toMatch(/2 items were removed from ArtCraft but are still in your pod/);
  const trigger = screen.getByRole("button", { name: "Remove these from my pod" });
  await user.click(trigger);
  expect(view.removeGoneFromPod).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole("alertdialog"));
  await user.click(screen.getByRole("button", { name: "Keep them" }));
  expect(view.removeGoneFromPod).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Remove these from my pod" }));
  await user.click(screen.getByRole("button", { name: "Remove these from my pod" }));
  await user.click(screen.getByRole("button", { name: "Remove from my pod" }));
  expect(view.removeGoneFromPod).toHaveBeenCalledTimes(1);
});

it("shows nothing about gone items when there are none", () => {
  renderWithMirror(SUMMARY);
  expect(screen.queryByTestId("pod-gone")).toBeNull();
  expect(screen.queryByTestId("pod-mirror-media-host")).toBeNull();
});

it("shows one banner when ArtCraft's media host cannot be reached", () => {
  renderWithMirror({ ...SUMMARY, mediaHostBlocked: true });
  expect(screen.getAllByTestId("pod-mirror-media-host")).toHaveLength(1);
});

it("explains a pod root that is readable by others or cannot be checked, offers only Check again, and never offers to confirm it", async () => {
  const user = userEvent.setup();
  const view = renderWithMirror({ ...SUMMARY, paused: "storage-unsafe", exposureTarget: "https://pod.example/alice/" });
  expect(screen.getByTestId("pod-mirror-paused").textContent).toMatch(/top level of your pod can be read by others, or ArtCraft could not check it/);
  expect(screen.queryByRole("button", { name: "Confirm this container is private" })).toBeNull();
  expect(screen.queryByTestId("pod-mirror-unverified")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Check again" }));
  expect(view.recheckExposure).toHaveBeenCalledTimes(1);
});
