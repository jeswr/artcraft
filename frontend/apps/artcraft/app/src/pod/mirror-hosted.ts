import { MediaFilesApi, type MediaFile, type Prompts, PromptsApi, StorytellerApiHostStore } from "@storyteller/api";
import type { HostedClient, HostedMediaFile, HostedPrompt, HostedResult } from "@storyteller/pod-mirror";

// Compile-time check: the hosted models still fit what the mirror reads.
type Fits<T extends U, U> = T;
export type MediaFileFits = Fits<MediaFile, HostedMediaFile>;
export type PromptFits = Fits<Prompts, HostedPrompt>;

/** The shape every hosted client call answers with. */
interface ApiResponse<T, P> {
  success: boolean;
  errorMessage?: string;
  data?: T;
  pagination?: P;
}

/** The hosted API says "not found" only through the status in its error text. */
const NOT_FOUND = /status: 404\b/;

function toResult<T>(response: ApiResponse<T, unknown>): HostedResult<T> {
  if (response.success && response.data !== undefined) return { ok: true, value: response.data };
  return { ok: false, kind: NOT_FOUND.test(response.errorMessage ?? "") ? "not-found" : "unavailable" };
}

/**
 * The mirror's hosted calls over the existing hosted clients (which keep using the hosted
 * session as before). Nothing here touches the pod.
 */
export function createHostedClient(
  username: string,
  currentUsername: () => string | null = () => username,
  currentHost: () => string = () => StorytellerApiHostStore.getInstance().getApiSchemeAndHost(),
): HostedClient {
  const media = new MediaFilesApi();
  const prompts = new PromptsApi();
  return {
    currentUsername,
    currentHost,
    // Each call passes the mirror's signal on, so stopping the mirror ends a stalled hosted request
    // instead of waiting for the network to give up.
    async getMediaFiles(tokens, signal) {
      return toResult(await media.ListMediaFilesByTokens({ mediaTokens: [...tokens] }, { signal }));
    },
    async getMediaFile(token, signal) {
      return toResult(await media.GetMediaFileByToken({ mediaFileToken: token }, { signal }));
    },
    async getPrompt(token, signal) {
      return toResult(await prompts.GetPromptsByToken({ token }, { signal }));
    },
    async listUserMediaFiles(pageIndex, pageSize, signal) {
      const response = await media.ListUserMediaFiles(
        {
          username,
          page_index: pageIndex,
          page_size: pageSize,
          include_user_uploads: true,
        },
        { signal },
      );
      if (!response.success || !response.data) {
        return { ok: false, kind: NOT_FOUND.test(response.errorMessage ?? "") ? "not-found" : "unavailable" };
      }
      return { ok: true, value: { items: response.data, totalPages: response.pagination?.total_page_count ?? null } };
    },
  };
}
