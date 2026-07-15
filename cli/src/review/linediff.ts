// Posture line-diff (LCS ghosts), ADR 0013 phase 3. Pure: no fs, no DOM. The
// diff between a composed cell and its other-posture sibling was computed in the
// browser; it now lives here so the model carries precomputed annotations and
// the template only colors them.

/** LCS table cap: above this many cells the quadratic table is skipped for a
 *  set-based O(n+m) fallback (order-blind), flagged `capped`. */
export const LCS_CELL_CAP = 2_500_000;

export interface LineDiff {
  /** Ranges [start, len] of lines exclusive to A. */
  ex: [number, number][];
  /** B-only lines, anchored after an A line index (-1 = before the first line). */
  ghosts: { after: number; lines: string[] }[];
  /** Set-based fallback was used (approximate, order-blind). */
  capped: boolean;
}

/** Collapse a set of line indices into sorted contiguous [start, len] ranges. */
export function toRanges(set: Set<number>): [number, number][] {
  const idx = [...set].sort((x, y) => x - y);
  const out: [number, number][] = [];
  for (const k of idx) {
    const last = out[out.length - 1];
    if (last && k === last[0] + last[1]) last[1]++;
    else out.push([k, 1]);
  }
  return out;
}

/** LCS line-diff of A vs B: lines exclusive to A as ranges, B-only lines as
 *  ghosts anchored after A indices. Huge files fall back to set membership. */
export function lineDiff(a: string[], b: string[]): LineDiff {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > LCS_CELL_CAP) {
    // Bounded fallback for huge files: set membership instead of the quadratic
    // LCS table. Approximate (order-blind), flagged as capped.
    const inB = new Set(b);
    const inA = new Set(a);
    const exA = new Set<number>();
    for (let i = 0; i < n; i++) if (!inB.has(a[i]!)) exA.add(i);
    const dropped = b.filter((l) => !inA.has(l));
    return { ex: toRanges(exA), ghosts: dropped.length ? [{ after: n - 1, lines: dropped }] : [], capped: true };
  }
  const dp = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const exA = new Set<number>();
  const ghosts: { after: number; lines: string[] }[] = [];
  let i = 0;
  let j = 0;
  let pending: string[] = [];
  let lastA = -1;
  const flush = () => {
    if (pending.length) {
      ghosts.push({ after: lastA, lines: pending });
      pending = [];
    }
  };
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      flush();
      lastA = i;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      flush();
      exA.add(i);
      lastA = i;
      i++;
    } else {
      pending.push(b[j]!);
      j++;
    }
  }
  while (i < n) {
    flush();
    exA.add(i);
    lastA = i;
    i++;
  }
  while (j < m) {
    pending.push(b[j]!);
    j++;
  }
  flush();
  return { ex: toRanges(exA), ghosts, capped: false };
}
