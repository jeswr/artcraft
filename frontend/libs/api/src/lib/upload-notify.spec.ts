// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const proxy = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@storyteller/tauri-utils", () => ({ FetchProxy: proxy.fetch }));

import { ApiManager, HOSTED_LIBRARY_CHANGED_EVENT } from "./ApiManager.js";

class Probe extends ApiManager {
  upload(endpoint: string) {
    return this.fetchMultipartFormData<unknown>(endpoint, { method: "POST", body: new FormData() });
  }
}

const listen = () => {
  const heard = vi.fn();
  window.addEventListener(HOSTED_LIBRARY_CHANGED_EVENT, heard);
  listeners.push(heard);
  return heard;
};
const listeners: ((event: Event) => void)[] = [];

afterEach(() => {
  for (const heard of listeners.splice(0)) window.removeEventListener(HOSTED_LIBRARY_CHANGED_EVENT, heard);
  proxy.fetch.mockReset();
});

describe("telling the app that an upload landed", () => {
  it("announces a successful media upload, and nothing else", async () => {
    const heard = listen();
    proxy.fetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    await new Probe().upload("https://api.example/v1/media_files/upload/image");
    expect(heard).toHaveBeenCalledTimes(1);
    await new Probe().upload("https://api.example/v1/other/thing");
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it("stays quiet when the upload is refused, and a later upload still announces itself", async () => {
    const heard = listen();
    proxy.fetch.mockResolvedValue({ ok: false, json: async () => ({ success: false }) });
    await new Probe().upload("https://api.example/v1/media_files/upload/image");
    expect(heard).not.toHaveBeenCalled();
    proxy.fetch.mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    await expect(new Probe().upload("https://api.example/v1/media_files/upload/image")).resolves.toEqual({ success: true });
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
