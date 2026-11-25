import { Button } from "@storyteller/ui-button";
import { LoadingSpinner } from "@storyteller/ui-loading-spinner";
import { SliderV2 } from "@storyteller/ui-sliderv2";
import { Tooltip } from "@storyteller/ui-tooltip";
import { podAssetKey, usePodAssets, type PodAsset, type PodGalleryAccess, type PodLibrary } from "@storyteller/pod-gallery";
import { RefreshCwIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PodPanelFrame, PodSkeleton } from "./PodPanelFrame";
import { PodTile } from "./PodTile";
import { PodViewer } from "./PodViewer";
import { GRID_PADDING, groupByDay, layoutGrid, visibleRows } from "./podLayout";
import { describeListError, EMPTY_DETAIL, EMPTY_TITLE, VIEW_ONLY_NOTE } from "./podMessages";

export interface PodGalleryPanelProps {
  access: PodGalleryAccess;
  /** The source switch, drawn by the gallery so it sits where it does in the ArtCraft view. */
  sourceSwitch: ReactNode;
  onClose: () => void;
  /** The gallery's column slider, shared so the size survives switching source. */
  sliderValue: number;
  onSliderChange: (value: number) => void;
  minColumns: number;
  maxColumns: number;
  gridColumns: number;
  imageFit: "cover" | "contain";
}

/** How close to the end of the list (in pixels) the next page is asked for. */
const LOAD_MORE_DISTANCE = 100;
/** Sizes assumed before the view has been measured (and where nothing can be measured). */
const FALLBACK_WIDTH = 1000;
const FALLBACK_HEIGHT = 600;

/**
 * The "My pod" source of the gallery: the assets in the person's pod library, newest day first,
 * shown in pages and drawn by row (only the rows near the view are mounted, and never more tiles
 * than the tile loader has room for). View only. Mounted only while the gallery is open on this
 * source and a pod is connected; unmounting releases every picture it holds.
 */
export default function PodGalleryPanel({ access, sourceSwitch, onClose, sliderValue, onSliderChange, minColumns, maxColumns, gridColumns, imageFit }: PodGalleryPanelProps) {
  const { state, loadMore, refresh } = usePodAssets(access);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState({ scrollTop: 0, width: FALLBACK_WIDTH, height: FALLBACK_HEIGHT });
  const [open, setOpen] = useState<{ asset: PodAsset; opener: HTMLElement } | null>(null);

  const measure = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    const width = node.clientWidth || FALLBACK_WIDTH;
    const height = node.clientHeight || FALLBACK_HEIGHT;
    setView((current) => (current.width === width && current.height === height && current.scrollTop === node.scrollTop ? current : { scrollTop: node.scrollTop, width, height }));
  }, []);
  const setScrollNode = useCallback(
    (node: HTMLDivElement | null) => {
      scrollRef.current = node;
      if (node) measure();
    },
    [measure],
  );
  useEffect(() => {
    const node = scrollRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [measure]);

  const ready = state.status === "ready" ? state : null;
  const groups = useMemo(() => (ready ? groupByDay(ready.items) : []), [ready?.items]);
  const layout = useMemo(() => layoutGrid(groups, gridColumns, view.width), [groups, gridColumns, view.width]);
  const rows = useMemo(() => visibleRows(layout, view.scrollTop, view.height), [layout, view.scrollTop, view.height]);

  // A list that does not fill the view has no scrolling to ask for the next page.
  useEffect(() => {
    if (ready?.hasMore && !ready.loadingMore && !ready.loadMoreFailed && (ready.items.length === 0 || layout.total - view.height < LOAD_MORE_DISTANCE)) loadMore();
  }, [ready, layout.total, view.height, loadMore]);

  const closeViewer = useCallback(() => setOpen(null), []);
  // A reload starts a new list: the item that was open belongs to the old one.
  useEffect(() => {
    if (state.status !== "ready") setOpen(null);
  }, [state.status]);
  // Closing the gallery frees every picture: the library outlives this panel, so releasing the holds
  // would leave the pictures cached as live blob URLs. Purging revokes them; resuming lets the next
  // open load again.
  const libraryRef = useRef<PodLibrary | null>(null);
  libraryRef.current = state.status === "ready" ? state.library : null;
  useEffect(
    () => () => {
      const library = libraryRef.current;
      if (!library) return;
      for (const loader of [library.tileLoader, library.viewerLoader]) {
        loader.purge();
        loader.resume();
      }
    },
    [],
  );
  const announcement =
    state.status === "loading"
      ? "Loading your pod library"
      : state.status === "error"
        ? describeListError(state.error).title
        : ready && ready.items.length === 0
          ? EMPTY_TITLE
          : ready
            ? `${ready.items.length} ${ready.items.length === 1 ? "item" : "items"} loaded${ready.hasMore ? ", more available" : ""}`
            : "";

  const controls = (
    <>
      <Tooltip position="top" content="Refresh list" closeOnClick={true}>
        <Button variant="action" onClick={refresh} className="relative z-[51] h-9 w-9 p-2.5" disabled={state.status === "loading"} aria-label="Refresh list">
          <RefreshCwIcon className={`text-lg text-base-fg ${state.status === "loading" ? "animate-spin" : ""}`} />
        </Button>
      </Tooltip>
      <div className="relative z-[51] mx-3 hidden w-32 items-center gap-2 sm:flex">
        <SliderV2
          min={minColumns}
          max={maxColumns}
          value={sliderValue}
          onChange={onSliderChange}
          step={1}
          variant="classic"
          showTooltip={false}
          className="w-full"
          showProgressBar={false}
          tooltipContent={`${maxColumns - (sliderValue - minColumns)} columns`}
        />
      </div>
    </>
  );

  return (
    <PodPanelFrame sourceSwitch={sourceSwitch} controls={controls} onClose={onClose}>
      <div
        ref={setScrollNode}
        className="flex-1 overflow-y-auto bg-ui-panel"
        onScroll={(event) => {
          const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
          setView((current) => (current.scrollTop === scrollTop ? current : { ...current, scrollTop }));
          if (scrollHeight - scrollTop - clientHeight < LOAD_MORE_DISTANCE) loadMore();
        }}
      >
        <span role="status" aria-live="polite" className="sr-only" data-testid="pod-announcement">
          {announcement}
        </span>
        <p className="px-4 pt-3 text-xs text-base-fg/70" data-testid="pod-view-only">
          {VIEW_ONLY_NOTE}
        </p>
        {state.status === "loading" && <PodSkeleton columns={gridColumns} />}
        {state.status === "error" && <ListError kind={state.error} onRetry={refresh} />}
        {ready && ready.items.length === 0 && ready.hasMore && (
          <div className="flex justify-center py-12">
            <LoadingSpinner className="h-8 w-8" />
          </div>
        )}
        {ready && ready.items.length === 0 && !ready.hasMore && (
          <div className="flex h-64 items-center justify-center px-6">
            <div className="flex max-w-sm flex-col items-center gap-2 text-center">
              <div className="text-sm text-base-fg/70">{EMPTY_TITLE}</div>
              <div className="text-xs text-base-fg/60">{EMPTY_DETAIL}</div>
              {ready.unreadable > 0 && <UnreadableNote count={ready.unreadable} />}
            </div>
          </div>
        )}
        {ready && ready.items.length > 0 && (
          <>
            <div className="relative" style={{ height: layout.total }} data-testid="pod-grid">
              {rows.map((row) =>
                row.kind === "heading" ? (
                  <h3 key={row.key} className="text-md absolute font-medium text-base-fg/70" style={{ top: row.top, left: GRID_PADDING, height: row.height }}>
                    {row.label}
                  </h3>
                ) : (
                  row.assets.map((asset, column) => (
                    <PodTile
                      key={podAssetKey(asset.ref)}
                      loader={ready.library.tileLoader}
                      sessionEnded={ready.library.sessionEnded?.bind(ready.library)}
                      asset={asset}
                      imageFit={imageFit}
                      onOpen={(item, opener) => setOpen({ asset: item, opener })}
                      style={{ top: row.top, left: GRID_PADDING + column * (layout.tileSize + layout.gap), width: layout.tileSize, height: layout.tileSize }}
                    />
                  ))
                ),
              )}
            </div>
            <div className="px-4 pb-4">
              {ready.loadingMore && (
                <div className="flex justify-center py-4">
                  <LoadingSpinner className="h-8 w-8" />
                </div>
              )}
              {ready.loadMoreFailed && (
                <div className="flex items-center justify-center gap-3 py-4 text-xs text-base-fg/70" role="alert">
                  <span>{ready.loadMoreError === "sign-in" ? "Sign in to your pod again (Settings, under Solid pod), then retry." : ready.loadMoreError === "forbidden" ? "Your pod refused access." : "Couldn't load more."}</span>
                  <button type="button" className="text-blue-400 underline hover:text-blue-300" onClick={() => loadMore({ force: true })}>
                    Retry
                  </button>
                </div>
              )}
              {!ready.hasMore && <div className="flex justify-center py-4 text-xs text-base-fg/60">No more items</div>}
              {ready.unreadable > 0 && (
                <div className="flex justify-center">
                  <UnreadableNote count={ready.unreadable} />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {ready && open && <PodViewer library={ready.library} asset={open.asset} opener={open.opener} onClose={closeViewer} />}
    </PodPanelFrame>
  );
}

function ListError({ kind, onRetry }: { kind: Parameters<typeof describeListError>[0]; onRetry: () => void }) {
  const { title, detail } = describeListError(kind);
  return (
    <div className="flex h-64 items-center justify-center px-6" role="alert">
      <div className="flex max-w-xs flex-col items-center gap-3 text-center text-sm">
        <div className="text-base-fg/70">{title}</div>
        <div className="text-xs text-base-fg/60">{detail}</div>
        <button type="button" className="text-xs text-blue-400 underline hover:text-blue-300" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}

function UnreadableNote({ count }: { count: number }) {
  return (
    <div className="text-xs text-base-fg/60">
      {count === 1 ? "1 file in your pod library can't be shown here." : `${count} files in your pod library can't be shown here.`}
    </div>
  );
}
