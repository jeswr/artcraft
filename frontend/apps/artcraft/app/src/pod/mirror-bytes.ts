import { BytesError, createPublicBytesFetcher, type FetchPublicBytes, isPublicHttpsUrl } from "@storyteller/pod-mirror";
import { LoadWithoutCors } from "@storyteller/tauri-api";

/**
 * Bytes of a public CDN file: a plain credential-free `fetch` first, and, only when the webview
 * cannot read it (CORS, a blocked host), the app's existing Rust byte loader. The loader returns
 * the whole body, so the size ceiling is checked after the fact on that path. Only hosted public
 * CDN addresses go through here; no pod traffic ever does.
 */
export function createCdnBytesFetcher(plain: FetchPublicBytes = createPublicBytesFetcher()): FetchPublicBytes {
  return async (url, options) => {
    try {
      return await plain(url, options);
    } catch (error) {
      if (!(error instanceof BytesError) || error.kind !== "unavailable" || !isPublicHttpsUrl(url)) throw error;
      if (options.signal?.aborted) throw error;
      try {
        const buffer = await LoadWithoutCors(url);
        if (buffer.byteLength > options.maxBytes) throw new BytesError("too-large");
        return new Uint8Array(buffer);
      } catch (fallback) {
        throw fallback instanceof BytesError ? fallback : new BytesError("unavailable");
      }
    }
  };
}
