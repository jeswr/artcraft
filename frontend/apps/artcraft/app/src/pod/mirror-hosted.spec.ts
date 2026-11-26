import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  GetMediaFileByToken: vi.fn(),
  ListMediaFilesByTokens: vi.fn(),
  ListUserMediaFiles: vi.fn(),
  GetPromptsByToken: vi.fn(),
  host: vi.fn(() => "https://api.example"),
}));
vi.mock("@storyteller/api", () => ({
  MediaFilesApi: class {
    GetMediaFileByToken = api.GetMediaFileByToken;
    ListMediaFilesByTokens = api.ListMediaFilesByTokens;
    ListUserMediaFiles = api.ListUserMediaFiles;
  },
  PromptsApi: class {
    GetPromptsByToken = api.GetPromptsByToken;
  },
  StorytellerApiHostStore: { getInstance: () => ({ getApiSchemeAndHost: () => api.host() }) },
}));

import { createHostedClient } from "./mirror-hosted";

beforeEach(() => vi.clearAllMocks());

describe("the hosted calls the mirror makes", () => {
  it("answers 'not found' only for a 404, and 'unavailable' for every other failure", async () => {
    const client = createHostedClient("alice_hosted");
    api.GetMediaFileByToken.mockResolvedValueOnce({ success: false, errorMessage: "request failed with status: 404" });
    expect(await client.getMediaFile("m_1")).toEqual({ ok: false, kind: "not-found" });
    for (const errorMessage of ["request failed with status: 500", "request failed with status: 4040", "network down", undefined]) {
      api.GetMediaFileByToken.mockResolvedValueOnce({ success: false, errorMessage });
      expect(await client.getMediaFile("m_1")).toEqual({ ok: false, kind: "unavailable" });
    }
  });

  it("hands the mirror's signal to every hosted request, so stopping the mirror ends them", async () => {
    api.GetMediaFileByToken.mockResolvedValue({ success: true, data: { token: "m_1" } });
    api.GetPromptsByToken.mockResolvedValue({ success: true, data: { token: "p_1" } });
    api.ListMediaFilesByTokens.mockResolvedValue({ success: true, data: [] });
    api.ListUserMediaFiles.mockResolvedValue({ success: true, data: [] });
    const { signal } = new AbortController();
    const client = createHostedClient("alice_hosted");
    await client.getMediaFile("m_1", signal);
    await client.getPrompt("p_1", signal);
    await client.getMediaFiles(["m_1"], signal);
    await client.listUserMediaFiles(0, 10, signal);
    for (const call of [api.GetMediaFileByToken, api.GetPromptsByToken, api.ListMediaFilesByTokens, api.ListUserMediaFiles]) {
      expect(call.mock.calls[0][1]).toEqual({ signal });
    }
  });

  it("passes the token on and returns the item", async () => {
    api.GetMediaFileByToken.mockResolvedValue({ success: true, data: { token: "m_1" } });
    api.GetPromptsByToken.mockResolvedValue({ success: true, data: { token: "p_1" } });
    const client = createHostedClient("alice_hosted");
    expect(await client.getMediaFile("m_1")).toEqual({ ok: true, value: { token: "m_1" } });
    expect(api.GetMediaFileByToken).toHaveBeenCalledWith({ mediaFileToken: "m_1" }, { signal: undefined });
    expect(await client.getPrompt("p_1")).toEqual({ ok: true, value: { token: "p_1" } });
    expect(api.GetPromptsByToken).toHaveBeenCalledWith({ token: "p_1" }, { signal: undefined });
  });

  it("lists the signed-in user's whole library, uploads included, one page at a time", async () => {
    api.ListUserMediaFiles.mockResolvedValue({ success: true, data: [{ token: "m_1" }], pagination: { total_page_count: 7 } });
    const client = createHostedClient("alice_hosted");
    expect(await client.listUserMediaFiles(2, 100)).toEqual({ ok: true, value: { items: [{ token: "m_1" }], totalPages: 7 } });
    expect(api.ListUserMediaFiles).toHaveBeenCalledWith({ username: "alice_hosted", page_index: 2, page_size: 100, include_user_uploads: true }, { signal: undefined });
    api.ListUserMediaFiles.mockResolvedValue({ success: true, data: [] });
    expect(await client.listUserMediaFiles(0, 10)).toMatchObject({ ok: true, value: { totalPages: null } });
    api.ListUserMediaFiles.mockResolvedValue({ success: false, errorMessage: "boom" });
    expect(await client.listUserMediaFiles(0, 10)).toEqual({ ok: false, kind: "unavailable" });
  });

  it("looks several items up with the batch call, and says which hosted user it is", async () => {
    api.ListMediaFilesByTokens.mockResolvedValue({ success: true, data: [{ token: "m_1" }] });
    const client = createHostedClient("alice_hosted", () => "someone_else");
    expect(await client.getMediaFiles(["m_1", "m_2"])).toEqual({ ok: true, value: [{ token: "m_1" }] });
    expect(api.ListMediaFilesByTokens).toHaveBeenCalledWith({ mediaTokens: ["m_1", "m_2"] }, { signal: undefined });
    expect(client.currentUsername()).toBe("someone_else");
    expect(client.currentHost()).toBe("https://api.example");
    api.host.mockReturnValue("http://localhost:12345");
    expect(client.currentHost()).toBe("http://localhost:12345"); // read when asked, so a change of backend is seen
    api.ListMediaFilesByTokens.mockResolvedValue({ success: false, errorMessage: "status: 500" });
    expect(await client.getMediaFiles(["m_1"])).toMatchObject({ ok: false });
  });
});
