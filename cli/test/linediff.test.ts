// Pure unit tests for the posture line-diff (ADR 0013 phase 3). Behavior must
// match what the review template computed in-page before extraction.

import { describe, expect, test } from "bun:test";
import { LCS_CELL_CAP, lineDiff } from "../src/review/linediff";

describe("lineDiff", () => {
  test("identical inputs have no exclusive lines and no ghosts", () => {
    const d = lineDiff(["a", "b", "c"], ["a", "b", "c"]);
    expect(d.ex).toEqual([]);
    expect(d.ghosts).toEqual([]);
    expect(d.capped).toBe(false);
  });

  test("pure insertion in B becomes a ghost anchored after the preceding A line", () => {
    const d = lineDiff(["a", "c"], ["a", "b", "c"]);
    expect(d.ex).toEqual([]);
    expect(d.ghosts).toEqual([{ after: 0, lines: ["b"] }]);
  });

  test("pure deletion (B is a subsequence of A) surfaces exclusive A ranges", () => {
    const d = lineDiff(["a", "b", "c", "d", "e"], ["a", "d", "e"]);
    expect(d.ex).toEqual([[1, 2]]);
    expect(d.ghosts).toEqual([]);
  });

  test("interleaved edit reports exact ranges and ghost anchors", () => {
    // h [1 2] m [3] t  vs  h m [4] t : 1,2 and 3 exclusive to A, 4 a ghost after m.
    const d = lineDiff(["h", "1", "2", "m", "3", "t"], ["h", "m", "4", "t"]);
    expect(d.ex).toEqual([
      [1, 2],
      [4, 1],
    ]);
    expect(d.ghosts).toEqual([{ after: 4, lines: ["4"] }]);
  });

  test("empty A vs non-empty B ghosts everything before the first line", () => {
    const d = lineDiff([], ["a", "b"]);
    expect(d.ex).toEqual([]);
    expect(d.ghosts).toEqual([{ after: -1, lines: ["a", "b"] }]);
  });

  test("oversized inputs fall back to the set-based diff flagged capped", () => {
    // (n+1)(m+1) must exceed the cap so the quadratic table is skipped.
    const a = Array.from({ length: 1600 }, (_, i) => `line${i}`);
    const b = a.slice();
    b[0] = "changed0";
    expect((a.length + 1) * (b.length + 1)).toBeGreaterThan(LCS_CELL_CAP);
    const d = lineDiff(a, b);
    expect(d.capped).toBe(true);
    // "line0" is only in A; "changed0" is only in B (anchored after A's last line).
    expect(d.ex).toEqual([[0, 1]]);
    expect(d.ghosts).toEqual([{ after: a.length - 1, lines: ["changed0"] }]);
  });
});
