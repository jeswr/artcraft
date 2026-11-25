import { useMedia } from "@jeswr/pod-media-loader/react";
import type { PodAsset, PodLibrary } from "@storyteller/pod-gallery";
import { BoxIcon, ImageOffIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { assetLabel } from "./PodTile";
import { dayHeading, describeMediaError, VIEW_ONLY_NOTE } from "./podMessages";

/** The actions the ArtCraft library offers that a pod item cannot have yet, each turned off with the reason. */
const DISABLED_ACTIONS = ["Use in a generation", "Add to a scene or board", "Delete"] as const;

/**
 * Shows one pod item in full, over the gallery. The file is loaded through the media loader
 * (a `blob:` URL typed by the sniffed type only), never by its pod address. A 3D model is a
 * generic tile with its thumbnail when it has one: its bytes are not given to a 3D loader.
 * Everything the pod wrote about the item (name, description, prompt) is shown as text.
 */
export function PodViewer({ library, asset, onClose }: { library: PodLibrary; asset: PodAsset; onClose: () => void }) {
  const [detail, setDetail] = useState(asset);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setDetail(asset);
    const abort = new AbortController();
    // The description may have been edited since the list was read.
    void library.source.get(asset.ref, abort.signal).then((result) => {
      if (result.ok && !abort.signal.aborted) setDetail(result.value);
    });
    return () => abort.abort();
  }, [library, asset]);

  useEffect(() => closeRef.current?.focus(), []);

  const label = assetLabel(detail);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="absolute inset-0 z-[60] flex flex-col bg-ui-background/95 text-base-fg backdrop-blur-sm sm:flex-row"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex min-h-0 flex-1 items-center justify-center p-4">
        <PodFullMedia library={library} asset={detail} />
      </div>
      <aside className="flex w-full flex-col gap-3 overflow-y-auto border-t border-ui-panel-border bg-ui-panel p-4 sm:w-72 sm:border-l sm:border-t-0">
        <div className="flex items-start justify-between gap-2">
          <h2 className="break-words text-lg font-semibold">{label}</h2>
          <button ref={closeRef} type="button" onClick={onClose} aria-label="Close" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[3px] text-base-fg/60 hover:bg-ui-controls/60 hover:text-base-fg">
            <XIcon className="text-sm" aria-hidden="true" />
          </button>
        </div>
        <dl className="flex flex-col gap-2 text-sm">
          <Detail term="Created" value={detail.createdAt ? dayHeading(detail.createdAt) : null} />
          <Detail term="Type" value={detail.declaredType} />
          <Detail term="Description" value={detail.description} multiline />
          <Detail term="Prompt" value={detail.prompt} multiline />
        </dl>
        <p className="text-xs text-base-fg/70" id="pod-view-only-note">
          {VIEW_ONLY_NOTE}
        </p>
        <div className="flex flex-col gap-2">
          {DISABLED_ACTIONS.map((action) => (
            <button key={action} type="button" disabled aria-describedby="pod-view-only-note" title={VIEW_ONLY_NOTE} className="cursor-not-allowed rounded-[3px] bg-ui-controls/40 px-3 py-1.5 text-left text-sm text-base-fg/40">
              {action}
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}

/** Pod text is untrusted: a text node, wrapped, with no link made out of anything in it. */
function Detail({ term, value, multiline }: { term: string; value: string | null; multiline?: boolean }) {
  if (!value) return null;
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-base-fg/50">{term}</dt>
      <dd className={multiline ? "whitespace-pre-wrap break-words" : "break-words"}>{value}</dd>
    </div>
  );
}

function PodFullMedia({ library, asset }: { library: PodLibrary; asset: PodAsset }) {
  // A model is shown by its thumbnail only; its file is never read here.
  const url = asset.kind === "model3d" ? asset.thumbnailUrl : asset.contentUrl;
  const poster = useMedia(library.loader, asset.kind === "video" ? asset.thumbnailUrl : null);
  const media = useMedia(library.loader, url);
  const label = assetLabel(asset);

  if (media.status === "error") {
    return <Placeholder icon="error" text={describeMediaError(media.error?.code ?? "failed")} />;
  }
  if (media.status === "loading") return <div className="h-48 w-48 animate-pulse bg-white/[0.06]" data-testid="pod-viewer-loading" />;
  if (media.status === "ready" && media.url) {
    if (asset.kind === "video") {
      return <video src={media.url} {...(poster.url ? { poster: poster.url } : {})} controls className="max-h-full max-w-full" aria-label={label} />;
    }
    return <img src={media.url} alt={label} className="max-h-full max-w-full object-contain" />;
  }
  // idle: a model without a thumbnail, or a video whose file could not be named.
  return <Placeholder icon="model" text={asset.kind === "model3d" ? "3D preview isn't available for pod items yet" : "No preview"} />;
}

function Placeholder({ icon, text }: { icon: "error" | "model"; text: string }) {
  const Icon = icon === "error" ? ImageOffIcon : BoxIcon;
  return (
    <div className="flex h-48 w-48 flex-col items-center justify-center gap-2 bg-black/30 px-3 text-center text-sm text-white/60" data-testid="pod-viewer-placeholder">
      <Icon className="text-2xl" aria-hidden="true" />
      <span>{text}</span>
    </div>
  );
}

