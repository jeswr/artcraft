import { useMedia } from "@jeswr/pod-media-loader/react";
import type { MediaLoader } from "@jeswr/pod-media-loader";
import type { PodAsset } from "@storyteller/pod-gallery";
import { BoxIcon, ImageIcon, ImageOffIcon, VideoIcon } from "lucide-react";
import { twMerge } from "tailwind-merge";
import { describeMediaError } from "./podMessages";

export function assetLabel(asset: PodAsset): string {
  if (asset.name) return asset.name;
  return asset.kind === "video" ? "Video" : asset.kind === "model3d" ? "3D model" : "Image";
}

/**
 * What a tile shows: the thumbnail the store returned, or for a plain image its own file. A video
 * or a 3D model without a thumbnail is a generic tile: a model's bytes are never fed to a 3D
 * loader (glTF can reference external files) and a video is not downloaded to draw a tile.
 */
export function previewUrl(asset: PodAsset): string | null {
  if (asset.thumbnailUrl) return asset.thumbnailUrl;
  return asset.kind === "image" ? asset.contentUrl : null;
}

const KIND_ICON = { image: ImageIcon, video: VideoIcon, model3d: BoxIcon } as const;

/** The picture of one pod item, loaded through the media loader as a `blob:` URL. Text only from fixed sentences. */
export function PodPreview({ loader, asset, url, imageFit = "contain" }: { loader: MediaLoader; asset: PodAsset; url: string | null; imageFit?: "cover" | "contain" }) {
  const media = useMedia(loader, url);
  const KindIcon = KIND_ICON[asset.kind];
  if (url === null || media.status === "idle") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-black/30 text-white/50" data-testid="pod-generic-tile">
        <KindIcon className="text-2xl" aria-hidden="true" />
        {asset.kind === "model3d" && <span className="text-[10px]">3D model</span>}
      </div>
    );
  }
  if (media.status === "error") {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-1 bg-black/30 px-2 text-center text-white/50" role="img" aria-label={describeMediaError(media.error?.code ?? "failed")} data-testid="pod-failed-tile">
        <ImageOffIcon className="text-xl" aria-hidden="true" />
        <span className="text-[10px] leading-tight">{describeMediaError(media.error?.code ?? "failed")}</span>
      </div>
    );
  }
  if (media.status === "loading" || !media.url) {
    return <div className="h-full w-full animate-pulse bg-white/[0.06]" data-testid="pod-loading-tile" />;
  }
  return (
    <img
      src={media.url}
      alt={assetLabel(asset)}
      draggable={false}
      className={twMerge("h-full w-full bg-black/30", imageFit === "contain" ? "object-contain" : "object-cover")}
    />
  );
}

/**
 * One tile in the "My pod" grid. It is a button that opens the viewer and nothing else: no drag,
 * no selection, no menu, and nothing that hands the item to hosted code.
 */
export function PodTile({ loader, asset, imageFit, onOpen }: { loader: MediaLoader; asset: PodAsset; imageFit?: "cover" | "contain"; onOpen: (asset: PodAsset) => void }) {
  const KindIcon = KIND_ICON[asset.kind];
  return (
    <div className="group relative aspect-square w-full">
      <button
        type="button"
        onClick={() => onOpen(asset)}
        aria-label={assetLabel(asset)}
        className="relative h-full w-full overflow-hidden border-2 border-transparent bg-ui-controls/30 hover:border-primary focus-visible:border-primary focus-visible:outline-none"
      >
        <PodPreview loader={loader} asset={asset} url={previewUrl(asset)} {...(imageFit ? { imageFit } : {})} />
        {asset.kind !== "image" && (
          <span className="pointer-events-none absolute bottom-2 left-2 flex h-6 w-6 items-center justify-center bg-black/50 text-white/80 backdrop-blur-lg">
            <KindIcon className="text-[10px]" aria-hidden="true" />
          </span>
        )}
      </button>
    </div>
  );
}
