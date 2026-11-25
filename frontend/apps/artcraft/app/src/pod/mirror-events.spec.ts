import { describe, expect, it, vi } from "vitest";
import type { MirrorSourceEvent } from "@storyteller/pod-mirror";
import { HOSTED_LIBRARY_CHANGED_EVENT } from "@storyteller/api";
import { createTauriMirrorEvents, TASK_QUEUE_UPDATE_EVENT } from "./mirror-events";

/** A stand-in for Tauri's `listen`: remembers the handlers so a test can fire an event. */
function fakeTauri() {
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  const off = vi.fn();
  const listen = (async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return off;
  }) as unknown as Parameters<typeof createTauriMirrorEvents>[0];
  return { listen, off, fire: (name: string, data: unknown) => handlers.get(name)?.({ payload: { status: "success", data } }), handlers };
}

function setup() {
  const tauri = fakeTauri();
  const target = new EventTarget() as unknown as Window;
  const events: MirrorSourceEvent[] = [];
  const unsubscribe = createTauriMirrorEvents(tauri.listen, target).subscribe((event) => events.push(event));
  return { ...tauri, target, events, unsubscribe };
}

describe("the app's events as the mirror's source", () => {
  it("reads the tokens of generated images and videos from the event payload", () => {
    const t = setup();
    t.fire("text_to_image_generation_complete_event", { generated_images: [{ media_token: "m_a" }, { media_token: "m_b" }, {}] });
    t.fire("video_generation_complete_event", { generated_video: { media_token: "m_v" } });
    expect(t.events).toEqual([
      { type: "added", tokens: ["m_a", "m_b"] },
      { type: "added", tokens: ["m_v"] },
    ]);
  });

  it("turns a delete event into a delete of that token", () => {
    const t = setup();
    t.fire("media_file_deleted_event", { media_file_token: "m_gone" });
    expect(t.events).toEqual([{ type: "deleted", token: "m_gone" }]);
  });

  it("falls back to 'something changed' when a payload does not look as expected", () => {
    const t = setup();
    t.fire("video_generation_complete_event", { nothing: true });
    t.fire("media_file_deleted_event", undefined);
    t.fire("text_to_image_generation_complete_event", { generated_images: "oops" });
    expect(t.events.every((event) => event.type === "changed")).toBe(true);
    expect(t.events).toHaveLength(3);
  });

  it.each([
    "generation-complete-event",
    "object_generation_complete_event",
    "gaussian_generation_complete_event",
    "image_edit_complete_event",
    "canvas_bg_removed_event",
  ])("treats %s as a change to walk for", (name) => {
    const t = setup();
    t.fire(name, { anything: 1 });
    expect(t.events).toEqual([{ type: "changed" }]);
  });

  it("hears an upload landing and a task queue update through the window, with no token", () => {
    const t = setup();
    t.target.dispatchEvent(new Event(HOSTED_LIBRARY_CHANGED_EVENT));
    t.target.dispatchEvent(new Event(TASK_QUEUE_UPDATE_EVENT));
    expect(t.events).toEqual([{ type: "changed" }, { type: "changed" }]);
  });

  it("stops listening everywhere when unsubscribed, and ignores what arrives late", async () => {
    const t = setup();
    t.unsubscribe();
    t.target.dispatchEvent(new Event(HOSTED_LIBRARY_CHANGED_EVENT));
    t.target.dispatchEvent(new Event(TASK_QUEUE_UPDATE_EVENT));
    t.fire("media_file_deleted_event", { media_file_token: "m_x" });
    await Promise.resolve();
    await Promise.resolve();
    expect(t.events).toEqual([]);
    expect(t.off).toHaveBeenCalledTimes(t.handlers.size);
  });
});
