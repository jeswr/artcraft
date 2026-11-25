// @vitest-environment node
import "fake-indexeddb/auto";
import { createMockOp } from "@jeswr/pod-auth/testing";
import { createDefaultAuth, createPodSession, type PodSessionConfig } from "@storyteller/pod-session";
import { afterEach, describe, expect, it, vi } from "vitest";
// Test doubles of pod-session (read only; nothing in that library is changed by this spec).
import { fakePodMode, memoryMarker } from "../../../../../libs/pod-session/src/lib/testing";

/**
 * M4 of the delta review: can a background read through the gallery's fetch (`session.getFetch()`,
 * the only fetch `gallery-runtime.ts` uses) open the system browser by itself?
 *
 * The wiring is ArtCraft's real one: `createPodSession` + `createDefaultAuth` (pod-auth with
 * desktop-auth's `getCode`), against pod-auth's in-memory identity provider; `host.openUrl` is the
 * Tauri opener. Findings are in the report; the second test pins the bug as a known failure.
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
  const session = createPodSession({
    config,
    createAuth: () => createDefaultAuth(config, host),
    wipeStores: async () => "wiped",
    podMode: fakePodMode({ podWindow: true, issuer: op.issuer, fresh: op.issuer }),
    marker: memoryMarker(),
    selfTest: async () => ({ ok: true }),
  });
  await session.start();
  await session.beginSignIn();
  expect(session.getState().kind).toBe("connected");
  expect(opened).toHaveLength(1); // the person's own sign-in
  return { op, session, opened, podFetch: session.getFetch()! };
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

  // The desired behaviour: a read that nobody asked the person about must never open the browser.
  // It does today, so this is marked as a known failure: it starts failing (and must be turned
  // into a plain `it`) when the sign-in gate exists. Observed: opened.length === 2, and a second
  // `GET /authorize` + `POST /token` against the provider, with the session still "connected".
  it.fails("after a failed refresh, does not open the system browser to sign in again (M4)", async () => {
    const { op, opened, podFetch } = await connected();
    op.failRefresh("invalid_grant");
    aDayLater();
    await podFetch(`${op.root}private`).catch(() => undefined);
    expect(opened).toHaveLength(1);
  });
});
