import { cleanup, render, screen } from "@testing-library/react";
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
import { PodAccountBlock } from "./PodAccountBlock";

const WEBID = "https://pod.example/alice/profile/card#me";

afterEach(cleanup);

function fakeSession(initial: PodSessionState, options: { podWindow?: boolean; config?: ConfigCheck } = {}) {
  let state = initial;
  const listeners = new Set<() => void>();
  const session = {
    getState: () => state,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    start: vi.fn(async () => state),
    connect: vi.fn(async () => undefined),
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
      act(() => listeners.forEach((l) => l()));
    },
  };
}

function renderBlock(initial: PodSessionState, options: { podWindow?: boolean; config?: ConfigCheck } = {}) {
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

it("tells the truth about this build: sign-in only, copying comes later, a restart loses unsaved work", () => {
  renderBlock({ kind: "disconnected" });
  const text = document.body.textContent ?? "";
  expect(text).toMatch(/does not copy any of your work to your pod/);
  expect(text).toMatch(/arrives in a later step/);
  expect(text).toMatch(/ArtCraft's servers still receive what you generate and upload/);
  expect(text).toMatch(/Anything unsaved in this window is lost/);
  expect(text).not.toMatch(/saves a copy/i);
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
