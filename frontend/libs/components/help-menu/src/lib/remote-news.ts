import { isPodMode } from "@storyteller/pod-mode";

/**
 * Fetches the remote news feed. Returns null, without making any request, in a pod window:
 * the feed is rendered as raw HTML, so it must never reach a window that holds credentials.
 * Also null for a non-OK response or a non-array body.
 */
export async function fetchRemoteNews(
  fetchImpl: typeof fetch = fetch,
): Promise<unknown[] | null> {
  if (isPodMode()) return null;
  const baseUrl = import.meta.env.DEV
    ? "http://localhost:4200"
    : "https://getartcraft.com";
  const res = await fetchImpl(`${baseUrl}/news.json`);
  if (!res.ok) return null;
  const data = await res.json();
  return Array.isArray(data) ? data : null;
}
