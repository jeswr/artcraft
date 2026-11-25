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
    approveOrigin: vi.fn(async () => undefined),
    openBrowser: vi.fn(),
    retry: vi.fn(async () => undefined),
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
  expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "WebID or identity provider address" }));
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
  const field = screen.getByRole("textbox", { name: "WebID or identity provider address" });
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
    import: {
      estimate: vi.fn(async () => ({ total: 120 })),
      start: vi.fn(async () => true),
      pause: vi.fn(async () => undefined),
      resume: vi.fn(async () => true),
      cancel: vi.fn(async () => undefined),
    },
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

const SUMMARY: MirrorSummary = { version: 1, running: true, paused: null, exposureTarget: null, counts: { saved: 4, pending: 2, failed: 1, skipped: 3, removing: 0 }, goneFromArtcraft: 0, mediaHostBlocked: false, import: { state: "idle", pausedBy: null, walked: 0, total: null, saved: 0, skipped: 0, failed: 0, pending: 0, startedAt: null, finishedAt: null } };
const POD_LIBRARY = "https://pod.example/alice/creative-assets/";

it("shows how the copy is going, in words", () => {
  renderWithMirror(SUMMARY);
  expect(screen.getByTestId("pod-mirror-status").textContent).toMatch(/Saved to pod: 4\. Waiting or saving: 2\. Not saved: 1\. Not copied: 3\./);
  expect(screen.queryByTestId("pod-mirror-paused")).toBeNull();
});

it("announces what needs attention, not the counts", () => {
  renderWithMirror(SUMMARY);
  const live = within(screen.getByTestId("pod-mirror-status")).getAllByRole("status")[0];
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

const RUNNING = { ...SUMMARY.import, state: "running" as const, walked: 30, total: 120, saved: 20, pending: 8, failed: 1, skipped: 1 };

it("says what copying the existing library will do before it starts, and starts only on a second click", async () => {
  const user = userEvent.setup();
  const view = renderWithMirror(SUMMARY);
  await user.click(screen.getByRole("button", { name: "Copy my existing library" }));
  const disclosure = await screen.findByTestId("pod-import-disclosure");
  expect(disclosure.textContent).toMatch(/120 items in your ArtCraft library/);
  expect(disclosure.textContent).toMatch(/long time/);
  expect(disclosure.textContent).toMatch(/storage on your pod/);
  expect(disclosure.textContent).toMatch(/pause or cancel/);
  expect(disclosure.textContent).toMatch(/every item stays in ArtCraft/);
  expect(view.import?.start).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Start copying" }));
  expect(view.import?.start).toHaveBeenCalledWith(120);
});

it("names the whole library when the number is not known, and Not now starts nothing", async () => {
  const user = userEvent.setup();
  const view = renderWithMirror(SUMMARY, { import: { ...renderlessControls(), estimate: async () => ({ total: null }) } });
  await user.click(screen.getByRole("button", { name: "Copy my existing library" }));
  expect((await screen.findByTestId("pod-import-disclosure")).textContent).toMatch(/all items in your ArtCraft library/);
  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(view.import?.start).not.toHaveBeenCalled();
  expect(screen.queryByTestId("pod-import-disclosure")).toBeNull();
});

it("shows a determinate bar with an accessible name while copying, and pauses or cancels from separate buttons", async () => {
  const user = userEvent.setup();
  const view = renderWithMirror({ ...SUMMARY, import: RUNNING });
  const bar = screen.getByRole("progressbar", { name: "Items looked at in your existing library" });
  expect(bar.getAttribute("max")).toBe("120");
  expect(bar.getAttribute("value")).toBe("30");
  expect(screen.getByTestId("pod-import-counts").textContent).toMatch(/Looked at 30 of 120\. Saved: 20\. Waiting: 8\. Not saved: 1\. Not copied: 1\./);
  await user.click(screen.getByRole("button", { name: "Pause copying" }));
  expect(view.import?.pause).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Cancel copying" }));
  expect(view.import?.cancel).toHaveBeenCalledTimes(1);
});

it("keeps the counts out of the live region and shows no bar value when the total is unknown", () => {
  renderWithMirror({ ...SUMMARY, import: { ...RUNNING, total: null } });
  expect(screen.getByRole("progressbar", { name: "Items looked at in your existing library" }).hasAttribute("value")).toBe(false);
  expect(screen.getByTestId("pod-import-state").textContent).not.toMatch(/\d/);
});

it("explains a pause for lack of pod space and offers resume", async () => {
  const user = userEvent.setup();
  const view = renderWithMirror({ ...SUMMARY, import: { ...RUNNING, state: "paused", pausedBy: "quota" } });
  expect(screen.getByTestId("pod-import-state").textContent).toMatch(/storage is full/);
  await user.click(screen.getByRole("button", { name: "Resume copying" }));
  expect(view.import?.resume).toHaveBeenCalledTimes(1);
});

it("offers to copy again after a finished or cancelled run, and renders nothing about it without a controller", () => {
  renderWithMirror({ ...SUMMARY, import: { ...RUNNING, state: "done" } });
  expect(screen.getByRole("button", { name: "Copy my existing library again" })).toBeTruthy();
});

function renderlessControls() {
  return { estimate: vi.fn(), start: vi.fn(async () => true), pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() };
}

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

it("moves focus into the import confirmation and back to the status line when it closes", async () => {
  const user = userEvent.setup();
  renderWithMirror(SUMMARY);
  await user.click(screen.getByRole("button", { name: "Copy my existing library" }));
  await screen.findByTestId("pod-import-disclosure");
  expect(document.activeElement).toBe(screen.getByRole("alertdialog"));
  await user.click(screen.getByRole("button", { name: "Not now" }));
  expect(document.activeElement).toBe(screen.getByTestId("pod-import-state"));
});

it("accepts a WebID as well as a provider address, and passes what was typed", async () => {
  const user = userEvent.setup();
  const { session } = renderBlock({ kind: "disconnected" });
  await user.type(screen.getByRole("textbox", { name: "WebID or identity provider address" }), `${WEBID}{Enter}`);
  expect(session.connect).toHaveBeenCalledWith(WEBID);
});

it("shows the typed WebID, the address the window was entered for and the allowed one apart before a sign-in continues", async () => {
  const user = userEvent.setup();
  const { session } = renderBlock(
    { kind: "ready-to-sign-in", issuer: "https://pod.example", webId: WEBID, approved: "https://login-example.net", purpose: "sign-in" },
    { podWindow: true },
  );
  const text = document.body.textContent ?? "";
  expect(text).toMatch(/You entered the WebID https:\/\/pod.example\/alice\/profile\/card#me/);
  // The allowed address, never the recorded one, is what "You allowed" names.
  expect(text).toMatch(/You allowed https:\/\/login-example.net as the place you sign in\./);
  expect(text).not.toMatch(/You allowed https:\/\/pod.example/);
  expect(text).toMatch(/Before your browser opens, ArtCraft shows you the address/);
  expect(session.beginSignIn).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Continue sign-in" }));
  expect(session.beginSignIn).toHaveBeenCalledTimes(1);
});

it.each([
  ["app-identity", /You allowed https:\/\/artcraft.example, where ArtCraft publishes its own identity document\./],
  ["profile", /You allowed https:\/\/artcraft.example to be read for your profile\./],
  ["storage", /You allowed https:\/\/artcraft.example\./],
] as const)("says what an allowed address was for (%s)", (purpose, expected) => {
  renderBlock({ kind: "ready-to-sign-in", issuer: "https://pod.example", approved: "https://artcraft.example", purpose }, { podWindow: true });
  expect(document.body.textContent).toMatch(expected);
});

it("shows the profile and the provider it names apart, and opens the browser only on a click that names the provider", async () => {
  const user = userEvent.setup();
  const { session } = renderBlock(
    { kind: "confirm-provider", provider: "https://login-example.net", webId: WEBID },
    { podWindow: true },
  );
  expect(document.body.textContent).toMatch(/Your profile is at https:\/\/pod.example\. It says you sign in at https:\/\/login-example.net\./);
  expect(screen.getByTestId("pod-provider").textContent).toBe("https://login-example.net");
  expect(document.body.textContent).toMatch(/Nothing has opened yet/);
  expect(session.openBrowser).not.toHaveBeenCalled();
  const button = screen.getByRole("button", { name: "Sign in at https://login-example.net" });
  expect(document.activeElement).not.toBe(button);
  await user.click(button);
  expect(session.openBrowser).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole("button", { name: "Cancel sign-in" }));
  expect(session.cancel).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Leave pod mode" })).toBeTruthy();
});

it("names the provider alone when a provider address was typed", () => {
  renderBlock({ kind: "confirm-provider", provider: "https://login.example" }, { podWindow: true });
  expect(document.body.textContent).toMatch(/You will sign in at https:\/\/login.example\./);
  expect(document.body.textContent).not.toMatch(/Your profile is at/);
});

it("never says it is signing in at an address before the browser is open", () => {
  renderBlock({ kind: "signing-in", issuer: "https://pod.example" }, { podWindow: true });
  expect(document.body.textContent).not.toMatch(/signing in at/);
  expect(document.body.textContent).toMatch(/Preparing your sign-in\. Your browser has not opened yet\./);
  cleanup();
  renderBlock({ kind: "signing-in", issuer: "https://pod.example", provider: "https://login-example.net" }, { podWindow: true });
  expect(document.body.textContent).toMatch(/signing in at https:\/\/login-example.net\./);
  expect(document.body.textContent).not.toMatch(/signing in at https:\/\/pod.example/);
});

it("explains a provider the profile named, says where the person will be asked to sign in, and only asks on a click", async () => {
  const user = userEvent.setup();
  const { session } = renderBlock(
    { kind: "needs-approval", origin: "https://login-example.net", phase: "sign-in", purpose: "sign-in", webId: WEBID },
    { podWindow: true },
  );
  const text = document.body.textContent ?? "";
  expect(text).toMatch(/Your profile at https:\/\/pod.example names https:\/\/login-example.net as the place you sign in\./);
  expect(text).toMatch(/nothing was sent there/);
  expect(text).toMatch(/asks you to sign in there, perhaps with your password/);
  expect(text).toMatch(/recognise https:\/\/login-example.net as your Solid provider/);
  expect(session.approveOrigin).not.toHaveBeenCalled();
  await user.click(screen.getByRole("button", { name: "Allow https://login-example.net as where I sign in" }));
  expect(session.approveOrigin).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Leave pod mode" })).toBeTruthy();
});

it("says the identity document host is ArtCraft's own, so the person is not told to refuse it", () => {
  renderBlock({ kind: "needs-approval", origin: "https://artcraft.example", phase: "sign-in", purpose: "app-identity" }, { podWindow: true });
  const text = document.body.textContent ?? "";
  expect(text).toMatch(/where ArtCraft publishes its own identity document/);
  expect(text).toMatch(/allowing it is normal when you sign in/);
  expect(text).not.toMatch(/Only allow this address/);
  expect(screen.getByRole("button", { name: "Allow https://artcraft.example" })).toBeTruthy();
});

it("says a profile is read from an address, with a caution to allow only the profile's own address", () => {
  renderBlock({ kind: "needs-approval", origin: "https://id.example", phase: "sign-in", purpose: "profile" }, { podWindow: true });
  expect(document.body.textContent).toMatch(/read your WebID profile from https:\/\/id.example/);
  expect(document.body.textContent).toMatch(/Only allow this address if it is where your profile lives/);
});

it("says the saved sign-in is kept and the window reloads when a reconnect needs an address", () => {
  renderBlock({ kind: "needs-approval", origin: "https://pod.example", phase: "restore", purpose: "storage" }, { podWindow: true });
  expect(document.body.textContent).toMatch(/Your saved sign-in is kept/);
  expect(document.body.textContent).toMatch(/reloads this window/);
  expect(screen.getByRole("button", { name: "Allow https://pod.example" })).toBeTruthy();
});

it.each([
  ["too-fast", /came too quickly to count as yours, so nothing changed\. Press Allow again/],
  ["busy", /not ready to ask again yet.*Wait a few seconds and press Allow again/],
] as const)("tells the person what to do after a %s answer, and Allow is still there", async (wait, expected) => {
  const user = userEvent.setup();
  const { session } = renderBlock(
    { kind: "needs-approval", origin: "https://login-example.net", phase: "sign-in", purpose: "sign-in", webId: WEBID, wait },
    { podWindow: true },
  );
  expect(document.body.textContent).toMatch(expected);
  await user.click(screen.getByRole("button", { name: "Allow https://login-example.net as where I sign in" }));
  expect(session.approveOrigin).toHaveBeenCalledTimes(1);
});

it.each(["origin-declined", "restore-failed"] as const)("offers Try again next to Leave for %s in a pod window", async (error) => {
  const user = userEvent.setup();
  const { session } = renderBlock({ kind: "error", error }, { podWindow: true });
  expect(screen.getByRole("alert").textContent).toBe(ERROR_TEXT[error]);
  await user.click(screen.getByRole("button", { name: "Try again" }));
  expect(session.retry).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Leave pod mode" })).toBeTruthy();
});

it.each(["origin-limit", "invalid-response", "sign-in-failed", "approval-too-fast"] as const)("offers only Leave for %s in a pod window", (error) => {
  renderBlock({ kind: "error", error }, { podWindow: true });
  expect(screen.getByRole("alert").textContent).toBe(ERROR_TEXT[error]);
  expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
});
