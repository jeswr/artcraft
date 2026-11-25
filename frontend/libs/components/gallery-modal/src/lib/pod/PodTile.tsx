import type { MediaLoader } from "@jeswr/pod-media-loader";
import { type PodAsset } from "@storyteller/pod-gallery";
import { usePodMedia } from "@storyteller/pod-gallery/media";
import { BoxIcon, ImageIcon, ImageOffIcon, RefreshCwIcon, VideoIcon } from "lucide-react";
import { type CSSProperties, useId } from "react";
import { twMerge } from "tailwind-merge";
import { describeMediaError, isFileRefusal, isRetryable, mayBeSessionEnd, SESSION_ENDED_MEDIA } from "./podMessages";

/** The text of an item's name, or a fixed word for its kind. Pod text is shown as text only. */
export function assetLabel(asset: PodAsset): string {
  if (asset.name) return asset.name;
  return asset.kind === "video" ? "Video" : asset.kind === "model3d" ? "3D model" : "Image";
}

/** Props that keep a picture from being dragged out or saved from its menu. */
export const noDrag = {
  draggable: false,
  onDragStart: (event: { preventDefault(): void }) => event.preventDefault(),
  onContextMenu: (event: { preventDefault(): void }) => event.preventDefault(),
} as const;

export const KIND_ICON = { image: ImageIcon, video: VideoIcon, model3d: BoxIcon } as const;

/**
 * One tile of the "My pod" grid. Its picture is the thumbnail the store returned, read through the
 * small-file tile loader. An item WITHOUT a thumbnail is a generic tile with its name: its full
 * file is never read for the grid, only in the viewer. The tile is a button that opens the viewer
 * and nothing else: no drag, no selection, no menu, nothing that hands the item to hosted code.
 * A failure is written on the tile (and read out), with "Try again" where a second attempt can help.
 */
export function PodTile({
  loader,
  sessionEnded,
  asset,
  imageFit = "contain",
  onOpen,
  style,
}: {
  loader: MediaLoader;
  /** Asked when a read failed: true when the session has ended, so the tile says to sign in. */
  sessionEnded?: () => boolean;
  asset: PodAsset;
  imageFit?: "cover" | "contain";
  onOpen: (asset: PodAsset, opener: HTMLElement) => void;
  style?: CSSProperties;
}) {
  const media = usePodMedia(loader, asset.thumbnail);
  const KindIcon = KIND_ICON[asset.kind];
  const label = assetLabel(asset);
  const statusId = useId();
  const rawCode = media.status === "over-budget" ? "over-budget" : media.error?.code;
  // A file the loader refuses (too many pixels, too large, not an image) is a generic tile with the
  // item's name, like an item with no thumbnail: it is not an error the person can act on.
  const refused = media.status === "error" && isFileRefusal(rawCode);
  const failed = (media.status === "error" && !refused) || media.status === "over-budget";
  const ended = failed && mayBeSessionEnd(rawCode) && sessionEnded?.() === true;
  const code = rawCode;
  const problem = failed ? (ended ? SESSION_ENDED_MEDIA : describeMediaError(code ?? "failed")) : null;
  const waiting = media.status === "loading";

  return (
    <div className="group absolute" style={style} data-pod-tile>
      <button
        type="button"
        onClick={(event) => onOpen(asset, event.currentTarget)}
        aria-label={label}
        aria-describedby={problem ? statusId : undefined}
        className="relative h-full w-full overflow-hidden border-2 border-transparent bg-ui-controls/30 hover:border-primary focus-visible:border-primary focus-visible:outline-none"
      >
        {media.status === "ready" && media.url ? (
          <img src={media.url} alt="" {...noDrag} className={twMerge("h-full w-full bg-black/30", imageFit === "contain" ? "object-contain" : "object-cover")} />
        ) : failed ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-black/30 px-2 text-center text-white/70" data-testid="pod-failed-tile">
            <ImageOffIcon className="text-xl" aria-hidden="true" />
            <span className="text-[11px] leading-tight">{problem}</span>
          </div>
        ) : waiting ? (
          <div className="h-full w-full animate-pulse bg-white/[0.06]" data-testid="pod-loading-tile" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-black/30 px-2 text-center text-white/70" data-testid="pod-generic-tile">
            <KindIcon className="text-2xl" aria-hidden="true" />
            <span className="line-clamp-2 break-words text-[11px] leading-tight">{label}</span>
          </div>
        )}
        {asset.kind !== "image" && media.status === "ready" && (
          <span className="pointer-events-none absolute bottom-2 left-2 flex h-6 w-6 items-center justify-center bg-black/50 text-white/80 backdrop-blur-lg">
            <KindIcon className="text-[10px]" aria-hidden="true" />
          </span>
        )}
      </button>
      {problem && (
        <span id={statusId} className="sr-only" data-testid="pod-tile-status">
          {problem}
        </span>
      )}
      {failed && isRetryable(code) && (
        <button
          type="button"
          onClick={media.retry}
          aria-label={`Try again: ${label}`}
          className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center bg-black/70 text-white hover:bg-black/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary"
        >
          <RefreshCwIcon className="text-xs" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
