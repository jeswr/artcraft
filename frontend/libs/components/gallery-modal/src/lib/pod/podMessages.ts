import type { MediaErrorCode } from "@jeswr/pod-media-loader";
import type { PodAssetsErrorKind } from "@storyteller/pod-gallery";

/** Why pod items cannot be used yet. Shown wherever an action is turned off for a pod item. */
export const VIEW_ONLY_NOTE =
  "Items from your pod are view-only for now: they can't be used in a generation, dragged into a scene or board, or deleted from here.";

/** Short, fixed sentences per closed error code. No pod text, URL or server message is ever shown. */
export function describeMediaError(code: MediaErrorCode): string {
  switch (code) {
    case "over-budget":
      return "Waiting for room to load";
    case "too-large":
      return "Too large to preview";
    case "unsupported-type":
      return "This file type can't be previewed";
    case "offline":
      return "Can't reach your pod";
    case "not-found":
      return "File not found in your pod";
    case "forbidden":
      return "Your pod refused access";
    case "aborted":
    case "purged":
      return "Not loaded";
    default:
      return "Couldn't load this file";
  }
}

/** What a tile or the viewer says when a read failed and the session has ended or been refused. */
export const SESSION_ENDED_MEDIA = "Sign in to your pod again";

/** Reads whose failure is explained by an ended session: the loaders report it as offline or refused. */
export function mayBeSessionEnd(code: MediaErrorCode | undefined): boolean {
  return code === "offline" || code === "forbidden" || code === "failed";
}

/** The loader refused the file itself (too many pixels, too big, not an image): the tile shows its name instead. */
export function isFileRefusal(code: MediaErrorCode | undefined): boolean {
  return code === "too-large" || code === "unsupported-type" || code === "out-of-scope";
}

/** Failures a second attempt can cure: the tile offers "Try again" for these. */
export function isRetryable(code: MediaErrorCode | undefined): boolean {
  return code === "over-budget" || code === "offline" || code === "failed" || code === "forbidden";
}

export function describeListError(kind: PodAssetsErrorKind): { title: string; detail: string } {
  switch (kind) {
    case "offline":
      return { title: "Your pod can't be reached", detail: "Check your connection. This list reloads when you're back online, or when you press Retry." };
    case "sign-in":
      return { title: "Sign in to your pod again", detail: "Your pod session has ended. Open Settings, under Solid pod, and choose Sign in again; this list reloads when you press Retry." };
    case "forbidden":
      return { title: "Your pod refused access", detail: "This account is not allowed to read the library. Settings, under Solid pod, shows which account is connected and lets you sign in again." };
    case "not-connected":
      return { title: "No pod is connected", detail: "Connect a pod from Settings, under Solid pod." };
    default:
      return { title: "Couldn't read your pod library", detail: "Try again in a moment." };
  }
}

/** "My pod" while the session has ended: nothing can be read until the person signs in again. */
export const SIGNED_OUT_TITLE = "Sign in to your pod again";
export const SIGNED_OUT_DETAIL =
  "Your pod session has ended, so ArtCraft stopped reading your pod. Nothing opened your browser. Sign in again to see your pod here; ArtCraft first asks you to confirm in a separate dialog and reloads this window.";

export const EMPTY_TITLE = "Nothing in your pod yet";
export const EMPTY_DETAIL =
  "ArtCraft saves a copy of new generations, uploads and edits to your pod while it is connected. Settings, under Solid pod, shows what has been copied so far.";

const UNDATED = "Undated";

/** A sortable local-day key ("2026-06-01"), or "" for an item with no usable date. */
export function dayKey(createdAt: string | null): string {
  if (!createdAt) return "";
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The day heading for a group of tiles, in the same style as the ArtCraft library's. */
export function dayHeading(createdAt: string | null, now: Date = new Date()): string {
  if (!createdAt) return UNDATED;
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return UNDATED;
  return date.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}
