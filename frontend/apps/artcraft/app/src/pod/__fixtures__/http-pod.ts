import type { StorageClient } from "@jeswr/storage-client";
import { cssStorage } from "@jeswr/storage-capabilities/testing";

/**
 * A Solid pod as an HTTP `fetch`, for tests that must see request METHODS. The data lives in a
 * memory storage client (seed it with the SDK's own store); this serves it over GET, HEAD and
 * OPTIONS the way a Community Solid Server does (the storage description and the OPTIONS answer
 * come from the SDK's CSS fixture). Any other method is recorded and refused with 405, so a test
 * that asserts "no write" sees it both in `requests` and as a failed request.
 */
export const HTTP_POD_ROOT = cssStorage.root;

export interface HttpPod {
  fetch: typeof fetch;
  /** Every request, in order, as `{ method, url }`. */
  requests: { method: string; url: string }[];
}

const STORAGE_DESCRIPTION = "https://css.example/.well-known/solid";

export function httpPod(data: StorageClient): HttpPod {
  const requests: HttpPod["requests"] = [];
  const described = (extra: Record<string, string>) => ({
    ...extra,
    link: [extra.link, `<${STORAGE_DESCRIPTION}>; rel="http://www.w3.org/ns/solid/terms#storageDescription"`].filter(Boolean).join(", "),
  });
  const podFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = request.url;
    requests.push({ method: request.method, url });
    if (request.method === "OPTIONS") {
      const fixture = cssStorage.responses[`OPTIONS ${HTTP_POD_ROOT}`];
      return new Response(null, { status: fixture?.status ?? 204, headers: fixture?.headers ?? {} });
    }
    if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405 });
    if (url === STORAGE_DESCRIPTION) {
      const fixture = cssStorage.responses[`GET ${STORAGE_DESCRIPTION}`];
      return new Response(request.method === "HEAD" ? null : (fixture?.body ?? "{}"), { status: 200, headers: fixture?.headers ?? {} });
    }
    if (!url.startsWith(HTTP_POD_ROOT)) return new Response(null, { status: 404 });
    try {
      if (url.endsWith("/")) {
        const listing = await data.list(url);
        const body = [
          `@prefix ldp: <http://www.w3.org/ns/ldp#>. @prefix dct: <http://purl.org/dc/terms/>. @prefix stat: <http://www.w3.org/ns/posix/stat#>.`,
          `<${url}> a ldp:BasicContainer; ldp:contains ${listing.items.map((entry) => `<${entry.url}>`).join(", ") || "()"}.`.replace("ldp:contains ().", "."),
          ...listing.items.map((entry) =>
            entry.kind === "container"
              ? `<${entry.url}> a ldp:BasicContainer.`
              : `<${entry.url}> a ldp:Resource${entry.contentType ? `, <http://www.w3.org/ns/iana/media-types/${entry.contentType}#Resource>` : ""}${entry.size === null ? "" : `; stat:size ${entry.size}`}${entry.modified ? `; dct:modified "${entry.modified.toISOString()}"^^<http://www.w3.org/2001/XMLSchema#dateTime>` : ""}.`,
          ),
        ].join("\n");
        const kinds = `<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"${url === HTTP_POD_ROOT ? `, <http://www.w3.org/ns/pim/space#Storage>; rel="type"` : ""}`;
        return new Response(request.method === "HEAD" ? null : body, { status: 200, headers: described({ "content-type": "text/turtle", link: kinds }) });
      }
      const found = await data.read(url);
      const bytes = await found.bytes();
      return new Response(request.method === "HEAD" ? null : bytes, {
        status: 200,
        headers: described({
          "content-type": found.contentType ?? "application/octet-stream",
          "content-length": String(bytes.byteLength),
          ...(found.etag ? { etag: found.etag } : {}),
          link: `<http://www.w3.org/ns/ldp#Resource>; rel="type"`,
        }),
      });
    } catch {
      return new Response(null, { status: 404 });
    }
  };
  return { fetch: podFetch as typeof fetch, requests };
}
