// @vitest-environment node
import "fake-indexeddb/auto";
import { createMockOp } from "@jeswr/pod-auth/testing";
import { createDefaultAuth, createPodSession, type PodSessionConfig } from "@storyteller/pod-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sessionPortFor } from "./mirror-ports";
// Test doubles of pod-session (read only; nothing in that library is changed by this spec).
import { fakePodMode, memoryHint, memoryMarker, memoryPending } from "../../../../../libs/pod-session/src/lib/testing";

/**
 * M4 of the delta review: can a background read through the gallery's fetch (`session.getFetch()`,
 * the only fetch `gallery-runtime.ts` uses) open the system browser by itself?
 *
 * The wiring is ArtCraft's real one: `createPodSession` + `createDefaultAuth` (pod-auth with
 * desktop-auth's `getCode`), against pod-auth's in-memory identity provider; `host.openUrl` is the
 * Tauri opener. The second test is the regression test for M4: a read that nobody asked the person
 * about used to open the browser; pod-session now refuses it and ends the session. The third is the
 * way back from that (M1 of the integration review): "Sign in again" in the same pod window, which
 * opens the browser only after the person's clicks.
 */
const config: PodSessionConfig = {
  clientId: "https://artcraft.example/solid-client-id.jsonld",
  redirectUri: "ai.artcraft.app:/oauth/callback",
  allowLoopbackHttp: false,
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function connected() {
  const op = createMockOp({ requireInteraction: true, refreshTokens: true });
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === config.clientId) {
      const document = await (await op.fetch(op.clientId)).json();
      return Response.json({ ...document, client_id: config.clientId, application_type: "native", redirect_uris: [config.redirectUri] });
    }
    return op.fetch(request);
  });
  let listener: ((urls: string[]) => void) | null = null;
  const opened: string[] = [];
  const host = {
    async onOpenUrl(handler: (urls: string[]) => void) {
      listener = handler;
      return () => undefined;
    },
    async openUrl(url: string) {
      opened.push(url);
      const callback = await op.getCode(new URL(url), new AbortController().signal);
      queueMicrotask(() => listener?.([callback]));
    },
  };
  const issuer = new URL(op.issuer).origin;
  // Page storage, which outlives a window rebuild.
  const pending = memoryPending({ hint: { kind: "issuer", issuer: op.issuer } });
  const lastSignIn = memoryHint();
  /** A pod window as the app builds it; `fresh` is the one-shot grant a dialog in this process left. */
  const podWindow = (fresh: string | null) =>
    createPodSession({
      config,
      createAuth: (options) => createDefaultAuth(config, host, options),
      wipeStores: async () => "wiped",
      podMode: fakePodMode({ podWindow: true, issuer, fresh }),
      marker: memoryMarker(),
      pending,
      signedIn: lastSignIn,
      selfTest: async () => ({ ok: true }),
    });
  const session = podWindow(issuer);
  await session.start();
  // The person's own sign-in: the click, the provider confirmation, the click that opens the browser.
  const signedIn = session.beginSignIn();
  await vi.waitFor(() => expect(session.getState().kind).toBe("confirm-provider"));
  session.openBrowser();
  await signedIn;
  expect(session.getState().kind).toBe("connected");
  expect(opened).toHaveLength(1); // the person's own sign-in
  return { op, session, opened, podWindow, issuer, podFetch: session.getFetch()! };
}

/** Five minutes is the mock token's lifetime: a day later the cached access token is expired. */
const aDayLater = () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 24 * 3600_000);
};

describe("a background read through the session's fetch", () => {
  it("renews an expired token with the refresh token and opens nothing", async () => {
    const { op, opened, podFetch } = await connected();
    aDayLater();
    const response = await podFetch(`${op.root}private`);
    expect(response.status).toBe(200);
    expect(op.stats.refreshes).toBe(1);
    expect(opened).toHaveLength(1);
  });

  // A read that nobody asked the person about must never open the browser. Before the gate it did:
  // opened.length === 2, a second `GET /authorize` + `POST /token`, and the session stayed "connected".
  it("after a failed refresh, does not open the system browser to sign in again (M4)", async () => {
    const { op, session, opened, podFetch } = await connected();
    op.failRefresh("invalid_grant");
    aDayLater();
    await podFetch(`${op.root}private`).catch(() => undefined);
    expect(opened).toHaveLength(1);
    // The session is no longer connected, so the mirror pauses and the gallery says "sign in again".
    expect(session.getState()).toEqual({ kind: "error", error: "session-ended" });
    expect(session.getFetch()).toBeNull();
    expect(sessionPortFor(session, op.webId).isConnected()).toBe(false);
  });

  it("after the gate ended the session, signs in again from the same pod window, opening the browser only after the clicks (M1)", async () => {
    const { op, session, opened, podWindow, issuer, podFetch } = await connected();
    op.failRefresh("invalid_grant");
    aDayLater();
    await podFetch(`${op.root}private`).catch(() => undefined);
    // The person is offered a way back, and nothing has opened.
    expect(session.getState()).toEqual({ kind: "error", error: "session-ended" });
    expect(session.canSignInAgain()).toBe(true);
    // The click asks the app (its dialog names the window's own issuer); the app rebuilds the window.
    await session.signInAgain();
    expect(opened).toHaveLength(1);
    const rebuilt = podWindow(issuer);
    await rebuilt.start();
    expect(rebuilt.getState()).toEqual({ kind: "ready-to-sign-in", issuer });
    expect(opened).toHaveLength(1);
    const signedIn = rebuilt.beginSignIn();
    await vi.waitFor(() => expect(rebuilt.getState().kind).toBe("confirm-provider"));
    expect(opened).toHaveLength(1);
    rebuilt.openBrowser();
    await signedIn;
    expect(rebuilt.getState().kind).toBe("connected");
    expect(opened).toHaveLength(2);
    expect((await rebuilt.getFetch()!(`${op.root}private`)).status).toBe(200);
  });
});
