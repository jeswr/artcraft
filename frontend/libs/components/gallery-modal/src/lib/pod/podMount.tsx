import { render } from "@testing-library/react";
import type { PodGalleryAccess } from "@storyteller/pod-gallery";
import { vi } from "vitest";
import PodGalleryPanel from "./PodGalleryPanel";
import type { testPod } from "./podTestKit";

/** Renders the panel on a test pod. */
export function mount(pod: ReturnType<typeof testPod>, props: { gridColumns?: number } = {}) {
  const access: PodGalleryAccess = { sessionKey: "https://alice.example/profile/card#me", open: async () => pod.library };
  const onClose = vi.fn();
  const view = render(
    <PodGalleryPanel
      access={access}
      sourceSwitch={<span data-testid="switch" />}
      onClose={onClose}
      sliderValue={7}
      onSliderChange={() => undefined}
      minColumns={3}
      maxColumns={12}
      gridColumns={props.gridColumns ?? 5}
      imageFit="contain"
    />,
  );
  return { ...view, onClose };
}

