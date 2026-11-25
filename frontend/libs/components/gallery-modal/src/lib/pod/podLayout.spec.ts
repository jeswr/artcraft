import { MAX_MOUNTED_TILES } from "@storyteller/pod-gallery";
import { describe, expect, it } from "vitest";
import { asset } from "./podTestKit";
import { groupByDay, layoutGrid, visibleRows } from "./podLayout";

const items = (count: number) => Array.from({ length: count }, (_, index) => asset(index + 1));

describe("the rows mounted for a view", () => {
  // A tall, narrow gallery at the slider's maximum of 12 columns used to stop at 160 tiles and leave
  // the bottom of the view blank.
  for (const [width, height] of [
    [1056, 1400],
    [1000, 1400],
    [1200, 1300],
    [1056, 2000],
    [1600, 1000],
    [2400, 1800],
  ] as const) {
    it(`fills a ${width}x${height} view at 12 columns, from the top and scrolled`, () => {
      const layout = layoutGrid(groupByDay(items(3000)), 12, width);
      for (const scrollTop of [0, 1234, 20_000]) {
        const rows = visibleRows(layout, scrollTop, height).filter((row) => row.kind === "tiles");
        const covered = rows.filter((row) => row.top + row.height > scrollTop && row.top < scrollTop + height);
        // Every tile row that touches the view is mounted: no blank band.
        const needed = layout.rows.filter((row) => row.kind === "tiles" && row.top + row.height > scrollTop && row.top < scrollTop + height);
        expect(covered.map((row) => row.key)).toEqual(needed.map((row) => row.key));
        const mounted = rows.reduce((sum, row) => sum + (row.kind === "tiles" ? row.assets.length : 0), 0);
        expect(mounted).toBeLessThanOrEqual(MAX_MOUNTED_TILES);
      }
    });
  }

  it("never drops a row that shows in the view, even past the tile cap, and drops the overscan first", () => {
    const layout = layoutGrid(groupByDay(items(3000)), 12, 1056);
    const rows = visibleRows(layout, 0, 1400, 24);
    const inView = layout.rows.filter((row) => row.kind === "tiles" && row.top < 1400);
    expect(rows.filter((row) => row.kind === "tiles").length).toBe(inView.length);
  });
});
