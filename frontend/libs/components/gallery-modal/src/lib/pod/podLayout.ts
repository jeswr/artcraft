import { MAX_MOUNTED_TILES, type PodAsset } from "@storyteller/pod-gallery";
import { dayHeading, dayKey } from "./podMessages";

/** Padding around the grid (`p-4`) and the heading and group spacing, in pixels. */
export const GRID_PADDING = 16;
export const HEADING_HEIGHT = 32;
export const GROUP_GAP = 24;

export interface DayGroup {
  key: string;
  heading: string;
  items: PodAsset[];
}

export type GridRow =
  | { kind: "heading"; key: string; top: number; height: number; label: string }
  | { kind: "tiles"; key: string; top: number; height: number; assets: PodAsset[] };

export interface Layout {
  rows: GridRow[];
  total: number;
  tileSize: number;
  gap: number;
}

/** Newest day first, undated last; inside a day, newest first (the store's order for ties). */
export function groupByDay(items: readonly PodAsset[]): DayGroup[] {
  const groups = new Map<string, DayGroup>();
  for (const asset of items) {
    const key = dayKey(asset.createdAt);
    const group = groups.get(key) ?? { key, heading: dayHeading(asset.createdAt), items: [] };
    groups.set(key, group);
    group.items.push(asset);
  }
  const time = (asset: PodAsset) => (asset.createdAt ? Date.parse(asset.createdAt) : 0);
  for (const group of groups.values()) group.items.sort((a, b) => time(b) - time(a));
  return [...groups.values()].sort((a, b) => (a.key === "" ? 1 : b.key === "" ? -1 : a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

export function gapFor(columns: number): number {
  return columns <= 4 ? 6 : columns <= 7 ? 4 : 2;
}

export function layoutGrid(groups: readonly DayGroup[], columns: number, width: number): Layout {
  const gap = gapFor(columns);
  const inner = Math.max(0, width - GRID_PADDING * 2);
  const tileSize = Math.max(1, (inner - gap * (columns - 1)) / columns);
  const rows: GridRow[] = [];
  let top = GRID_PADDING;
  groups.forEach((group, index) => {
    if (index > 0) top += GROUP_GAP;
    rows.push({ kind: "heading", key: `h-${group.key}`, top, height: HEADING_HEIGHT, label: group.heading });
    top += HEADING_HEIGHT;
    for (let start = 0; start < group.items.length; start += columns) {
      rows.push({ kind: "tiles", key: `r-${group.key}-${start}`, top, height: tileSize, assets: group.items.slice(start, start + columns) });
      top += tileSize + gap;
    }
  });
  return { rows, total: top + GRID_PADDING, tileSize, gap };
}

/** The rows to mount: those on or one row-height near the view, never more than `maxTiles` tiles. */
export function visibleRows(layout: Layout, scrollTop: number, viewport: number, maxTiles = MAX_MOUNTED_TILES): GridRow[] {
  const margin = layout.tileSize;
  const from = scrollTop - margin;
  const to = scrollTop + viewport + margin;
  const out: GridRow[] = [];
  let tiles = 0;
  for (const row of layout.rows) {
    if (row.top + row.height < from) continue;
    if (row.top > to) break;
    if (row.kind === "tiles") {
      if (tiles + row.assets.length > maxTiles) break;
      tiles += row.assets.length;
    }
    out.push(row);
  }
  return out;
}
