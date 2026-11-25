import type { PodAsset, PodLibrary } from "@storyteller/pod-gallery";
import { usePodMedia, usePodOriginal } from "@storyteller/pod-gallery/media";
import { BoxIcon, ImageOffIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { assetLabel } from "./PodTile";
import { dayHeading, describeMediaError, isRetryable, VIEW_ONLY_NOTE } from "./podMessages";

/** The actions the ArtCraft library offers that a pod item cannot have yet, each turned off with the reason. */
const DISABLED_ACTIONS = ["Use in a generation", "Add to a scene or board", "Delete"] as const;

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

/** Media that must not be draggable out of the viewer, saved from its menu, cast or popped out. */
const noDrag = { draggable: false, onDragStart: (event: { preventDefault(): void }) => event.preventDefault(), onContextMenu: (event: { preventDefault(): void }) => event.preventDefault() } as const;

/**
 * Shows one pod item in full, over the gallery. The file is read through the viewer loader and
 * the element is chosen from the type the loader SNIFFED in the bytes, never from what the pod
 * declares. A 3D model shows its thumbnail only: its bytes are not given to a 3D loader.
 * Everything the pod wrote about the item (name, description, prompt) is shown as text.
 *
 * It is a modal dialog: focus moves in, Tab stays inside, Escape closes only this view (it is
 * caught before the gallery's own Escape handling), and focus goes back to the tile that opened it.
 */
export function PodViewer({ library, asset, opener, onClose }: { library: PodLibrary; asset: PodAsset; opener: HTMLElement | null; onClose: () => void }) {
  const [detail, setDetail] = useState(asset);
  const root = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    setDetail(asset);
    const abort = new AbortController();
    // The description may have been edited since the list was read.
    void library.source.get(asset.ref, abort.signal).then((result) => {
      if (result.ok && !abort.signal.aborted) setDetail(result.value);
    });
    return () => abort.abort();
  }, [library, asset]);

  useEffect(() => {
    closeRef.current?.focus();
    // Window, capture phase: before the dialog library's Escape handling, so the gallery stays open.
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" && event.key !== "Esc") return;
      event.stopImmediatePropagation();
      event.preventDefault();
      onCloseRef.current();
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [opener]);

  const trap = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !root.current) return;
    const stops = Array.from(root.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((node) => !node.hasAttribute("disabled"));
    const first = stops[0];
    const last = stops[stops.length - 1];
    if (!first || !last) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !root.current.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !root.current.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  };

  const label = assetLabel(detail);
  return (
    <div
      ref={root}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      className="absolute inset-0 z-[60] flex flex-col bg-ui-background/95 text-base-fg backdrop-blur-sm sm:flex-row"
      onKeyDown={trap}
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
            // aria-disabled, not disabled: still reachable by keyboard, so the reason is too.
            <button key={action} type="button" aria-disabled="true" aria-describedby="pod-view-only-note" onClick={(event) => event.preventDefault()} className="cursor-not-allowed rounded-[3px] bg-ui-controls/40 px-3 py-1.5 text-left text-sm text-base-fg/70">
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
      <dt className="text-xs uppercase tracking-wide text-base-fg/60">{term}</dt>
      <dd className={multiline ? "whitespace-pre-wrap break-words" : "break-words"}>{value}</dd>
    </div>
  );
}

function PodFullMedia({ library, asset }: { library: PodLibrary; asset: PodAsset }) {
  // A model is shown by its thumbnail only; its file is never read here.
  if (asset.kind === "model3d") return <ModelPreview library={library} asset={asset} />;
  return <OriginalMedia library={library} asset={asset} />;
}

function ModelPreview({ library, asset }: { library: PodLibrary; asset: PodAsset }) {
  const media = usePodMedia(library.viewerLoader, asset.thumbnail);
  if (media.status === "ready" && media.url) {
    return <img src={media.url} alt={assetLabel(asset)} {...noDrag} className="max-h-full max-w-full object-contain" />;
  }
  if (media.status === "loading") return <div className="h-48 w-48 animate-pulse bg-white/[0.06]" data-testid="pod-viewer-loading" />;
  if (media.status === "error" || media.status === "over-budget") {
    return <Problem code={media.status === "over-budget" ? "over-budget" : media.error?.code} onRetry={media.retry} />;
  }
  return <Problem text="3D preview isn't available for pod items yet" icon="model" />;
}

function OriginalMedia({ library, asset }: { library: PodLibrary; asset: PodAsset }) {
  const original = usePodOriginal(library.viewerLoader, asset.content);
  const label = assetLabel(asset);
  if (original.status === "loading") return <div className="h-48 w-48 animate-pulse bg-white/[0.06]" data-testid="pod-viewer-loading" />;
  if (original.status === "error" || !original.url) return <Problem code={original.error?.code} onRetry={original.retry} />;
  const type = original.contentType ?? "";
  if (type.startsWith("image/")) return <img src={original.url} alt={label} {...noDrag} className="max-h-full max-w-full object-contain" />;
  if (type.startsWith("video/")) {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- the pod's own file; there is no caption track to offer
      <video src={original.url} controls controlsList="nodownload noremoteplayback" disablePictureInPicture disableRemotePlayback {...noDrag} className="max-h-full max-w-full" aria-label={label} />
    );
  }
  if (type.startsWith("audio/")) {
    return <audio src={original.url} controls controlsList="nodownload noremoteplayback" {...noDrag} aria-label={label} />;
  }
  return <Problem text="This file type can't be previewed" />;
}

function Problem({ code, text, icon = "error", onRetry }: { code?: Parameters<typeof describeMediaError>[0] | undefined; text?: string; icon?: "error" | "model"; onRetry?: () => void }) {
  const Icon = icon === "error" ? ImageOffIcon : BoxIcon;
  const message = text ?? describeMediaError(code ?? "failed");
  return (
    <div className="flex h-48 w-48 flex-col items-center justify-center gap-2 bg-black/30 px-3 text-center text-sm text-white/80" data-testid="pod-viewer-placeholder" role="status">
      <Icon className="text-2xl" aria-hidden="true" />
      <span>{message}</span>
      {onRetry && isRetryable(code) && (
        <button type="button" onClick={onRetry} className="text-xs text-blue-300 underline hover:text-blue-200">
          Try again
        </button>
      )}
    </div>
  );
}
