import { posthog } from "posthog-js";
import { analyticsAllowed } from "@storyteller/pod-mode";

type PostHogInit = (apiKey: string, config: Record<string, string>) => unknown;

/** Initialises PostHog unless this is a pod window. Returns whether it initialised. */
export function initPostHogIfAllowed(
  apiKey: string,
  init: PostHogInit = (k, c) => posthog.init(k, c),
): boolean {
  if (!analyticsAllowed()) return false;
  init(apiKey, {
    api_host: "https://us.i.posthog.com/",
    ui_host: "https://us.i.posthog.com/",
  });
  return true;
}
