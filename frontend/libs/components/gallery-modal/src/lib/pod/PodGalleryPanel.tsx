import { Button } from "@storyteller/ui-button";
import { CloseButton } from "@storyteller/ui-close-button";
import { LoadingSpinner } from "@storyteller/ui-loading-spinner";
import { Modal } from "@storyteller/ui-modal";
import { SliderV2 } from "@storyteller/ui-sliderv2";
import { Tooltip } from "@storyteller/ui-tooltip";
import { podAssetDescriptionUrl, usePodAssets, type PodAsset, type PodGalleryAccess } from "@storyteller/pod-gallery";
import { RefreshCwIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { twMerge } from "tailwind-merge";
import { LazyDateGroup, SkeletonGrid } from "../gallery-modal";
import { PodTile } from "./PodTile";
import { PodViewer } from "./PodViewer";
import { dayHeading, describeListError, EMPTY_DETAIL, EMPTY_TITLE, VIEW_ONLY_NOTE } from "./podMessages";

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

/**
 * The "My pod" source of the gallery: the assets in the person's pod library, newest first as
 * the store lists them, shown in pages. View only. Mounted only while the gallery is open on
 * this source and a pod is connected; unmounting releases every picture it holds.
 */
export default function PodGalleryPanel({ access, sourceSwitch, onClose, sliderValue, onSliderChange, minColumns, maxColumns, gridColumns, imageFit }: PodGalleryPanelProps) {
  const { state, loadMore, refresh } = usePodAssets(access);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [open, setOpen] = useState<PodAsset | null>(null);
  const setScrollNode = useCallback((node: HTMLDivElement | null) => {
    scrollRef.current = node;
    setScrollRoot(node);
  }, []);

  // A page that does not fill the view has no scrolling to ask for the next one.
  const ready = state.status === "ready" ? state : null;
  useEffect(() => {
    const node = scrollRef.current;
    if (ready?.hasMore && !ready.loadingMore && !ready.loadMoreFailed && node && node.scrollHeight - node.clientHeight < LOAD_MORE_DISTANCE) loadMore();
  }, [ready, loadMore]);

  const groups = useMemo(() => (ready ? groupByDay(ready.items) : []), [ready]);
  const gapClass = gridColumns <= 4 ? "gap-1.5" : gridColumns <= 7 ? "gap-1" : "gap-0.5";

  return (
    <div className="relative flex h-full flex-col" data-pod-gallery>
      <div className="border-b border-ui-panel-border bg-ui-panel p-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-y-2">
          <div className="flex flex-wrap items-center gap-3 gap-y-1">
            {sourceSwitch}
            <h2 className="relative z-[51] text-lg font-semibold">My pod</h2>
          </div>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
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
            <Modal.ExpandButton />
            <CloseButton onClick={onClose} className="relative z-[51]" />
          </div>
        </div>
      </div>

      <div
        ref={setScrollNode}
        className="flex-1 overflow-y-auto bg-ui-panel"
        onScroll={(event) => {
          const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
          if (scrollHeight - scrollTop - clientHeight < LOAD_MORE_DISTANCE) loadMore();
        }}
      >
        <p className="px-4 pt-3 text-xs text-base-fg/60" data-testid="pod-view-only">
          {VIEW_ONLY_NOTE}
        </p>
        {state.status === "loading" && <SkeletonGrid columns={gridColumns} />}
        {state.status === "error" && <ListError kind={state.error} onRetry={refresh} />}
        {ready && ready.items.length === 0 && (
          <div className="flex h-64 items-center justify-center px-6">
            <div className="flex max-w-sm flex-col items-center gap-2 text-center">
              <div className="text-sm text-base-fg/70">{EMPTY_TITLE}</div>
              <div className="text-xs text-base-fg/50">{EMPTY_DETAIL}</div>
              {ready.unreadable > 0 && <UnreadableNote count={ready.unreadable} />}
            </div>
          </div>
        )}
        {ready && ready.items.length > 0 && (
          <div className="space-y-6 p-4">
            {groups.map((group, groupIndex) => (
              <LazyDateGroup key={group.heading} eager={groupIndex < 2} itemCount={group.items.length} gridColumns={gridColumns} scrollRoot={scrollRoot}>
                <h3 className="text-md mb-2 font-medium text-base-fg/60">{group.heading}</h3>
                <div className={twMerge("grid", gapClass)} style={{ gridTemplateColumns: `repeat(${gridColumns}, minmax(0, 1fr))` }}>
                  {group.items.map((asset) => (
                    <PodTile key={asset.key} loader={ready.library.loader} asset={asset.asset} imageFit={imageFit} onOpen={setOpen} />
                  ))}
                </div>
              </LazyDateGroup>
            ))}
            {ready.loadingMore && (
              <div className="flex justify-center py-4">
                <LoadingSpinner className="h-8 w-8" />
              </div>
            )}
            {ready.loadMoreFailed && (
              <div className="flex items-center justify-center gap-3 py-4 text-xs text-base-fg/60">
                <span>Couldn't load more.</span>
                <button type="button" className="text-blue-400 underline hover:text-blue-300" onClick={loadMore}>
                  Retry
                </button>
              </div>
            )}
            {!ready.hasMore && <div className="flex justify-center py-4 text-xs text-base-fg/40">No more items</div>}
            {ready.unreadable > 0 && (
              <div className="flex justify-center">
                <UnreadableNote count={ready.unreadable} />
              </div>
            )}
          </div>
        )}
      </div>

      {ready && open && <PodViewer library={ready.library} asset={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function ListError({ kind, onRetry }: { kind: Parameters<typeof describeListError>[0]; onRetry: () => void }) {
  const { title, detail } = describeListError(kind);
  return (
    <div className="flex h-64 items-center justify-center px-6" role="alert">
      <div className="flex max-w-xs flex-col items-center gap-3 text-center text-sm">
        <div className="text-base-fg/70">{title}</div>
        <div className="text-xs text-base-fg/50">{detail}</div>
        <button type="button" className="text-xs text-blue-400 underline hover:text-blue-300" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  );
}

function UnreadableNote({ count }: { count: number }) {
  return (
    <div className="text-xs text-base-fg/40">
      {count === 1 ? "1 file in your pod library can't be shown here." : `${count} files in your pod library can't be shown here.`}
    </div>
  );
}

interface DayGroup {
  heading: string;
  items: { key: string; asset: PodAsset }[];
}

/** Groups in the order the store lists them: the first item of a day opens its group. */
function groupByDay(items: readonly PodAsset[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const asset of items) {
    const heading = dayHeading(asset.createdAt);
    const group = groups.get(heading) ?? { heading, items: [] };
    groups.set(heading, group);
    group.items.push({ key: podAssetDescriptionUrl(asset.ref), asset });
  }
  return [...groups.values()];
}
