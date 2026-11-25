import { HOSTED_LIBRARY_CHANGED_EVENT } from "@storyteller/api";
import type { MirrorEventSource, MirrorSourceEvent } from "@storyteller/pod-mirror";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

interface Wrapped<T> {
  payload: { data: T };
}

/** Completion events that carry no tokens: they only say the library changed. */
const CHANGE_EVENTS = [
  "generation-complete-event",
  "object_generation_complete_event",
  "gaussian_generation_complete_event",
  "image_edit_complete_event",
  "canvas_bg_removed_event",
] as const;

/** The window event the task queue fires when a task changes. */
export const TASK_QUEUE_UPDATE_EVENT = "task-queue-update";

/** Window events that say "look at the library again": an upload landed, or a task moved. */
const WINDOW_CHANGE_EVENTS = [HOSTED_LIBRARY_CHANGED_EVENT, TASK_QUEUE_UPDATE_EVENT] as const;

/**
 * The existing Tauri events, as the mirror's source. Listening starts on `subscribe` and stops
 * on the returned function. Payload fields are read defensively: an event that does not look as
 * expected falls back to "something changed", which makes the mirror walk the listing.
 */
export function createTauriMirrorEvents(listenFn: typeof listen = listen, target: Pick<Window, "addEventListener" | "removeEventListener"> = window): MirrorEventSource {
  return {
    subscribe(handler: (event: MirrorSourceEvent) => void) {
      let stopped = false;
      const unlisteners: Promise<UnlistenFn>[] = [];
      const on = <T>(name: string, map: (data: T) => MirrorSourceEvent) => {
        unlisteners.push(
          listenFn<Wrapped<T>["payload"]>(name, (event) => {
            if (stopped) return;
            try {
              handler(map(event.payload?.data as T));
            } catch {
              handler({ type: "changed" });
            }
          }),
        );
      };
      on<{ generated_images?: { media_token?: string }[] }>("text_to_image_generation_complete_event", (data) => ({
        type: "added",
        tokens: (data?.generated_images ?? []).map((image) => image.media_token).filter((t): t is string => typeof t === "string"),
      }));
      on<{ generated_video?: { media_token?: string } }>("video_generation_complete_event", (data) =>
        typeof data?.generated_video?.media_token === "string"
          ? { type: "added", tokens: [data.generated_video.media_token] }
          : { type: "changed" },
      );
      on<{ media_file_token?: string }>("media_file_deleted_event", (data) =>
        typeof data?.media_file_token === "string" ? { type: "deleted", token: data.media_file_token } : { type: "changed" },
      );
      for (const name of CHANGE_EVENTS) on<unknown>(name, () => ({ type: "changed" }));
      // Uploads and editor outputs announce nothing through Tauri. The mirror walks the library
      // after a quiet moment (one walk for a burst), so these need no token.
      const onWindowEvent = () => {
        if (!stopped) handler({ type: "changed" });
      };
      for (const name of WINDOW_CHANGE_EVENTS) target.addEventListener(name, onWindowEvent);
      return () => {
        stopped = true;
        for (const name of WINDOW_CHANGE_EVENTS) target.removeEventListener(name, onWindowEvent);
        for (const pending of unlisteners) void pending.then((off) => off()).catch(() => undefined);
      };
    },
  };
}
