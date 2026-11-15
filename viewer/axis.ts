// Real time (ms) <-> visual time (ms). Stretches where no agent does anything for > GAP are
// squeezed to GAP_W, both on the timeline and during playback, so idle never eats the screen.

const GAP = 45_000;
const GAP_W = 5_000;

type Seg = { t0: number; t1: number; v0: number };
export type Axis = {
  total: number; // visual length
  toV(t: number): number;
  toT(v: number): number;
  gaps: { v0: number; v1: number; ms: number }[]; // squeezed stretches, in visual coordinates
  inGap(t: number): boolean;
};

export function makeAxis(events: { t: number; dur: number }[], maxT: number, collapse: boolean): Axis {
  let segs: Seg[] = [{ t0: 0, t1: maxT, v0: 0 }];
  if (collapse && events.length) {
    const iv = events.map((e) => [e.t, e.t + Math.max(e.dur, 1500)]).sort((a, b) => a[0] - b[0]);
    const merged: number[][] = [];
    for (const [s, e] of iv) {
      const last = merged.at(-1);
      if (last && s <= last[1] + GAP) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    merged[0][0] = 0;
    merged.at(-1)![1] = Math.max(merged.at(-1)![1], maxT);
    let v = 0;
    segs = merged.map(([s, e], i) => {
      if (i) v += GAP_W;
      const seg = { t0: s, t1: e, v0: v };
      v += e - s;
      return seg;
    });
  }
  const last = segs.at(-1)!;
  const total = last.v0 + last.t1 - last.t0;

  const toV = (t: number) => {
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i];
      if (t < s.t0) continue;
      if (t <= s.t1) return s.v0 + t - s.t0;
      const n = segs[i + 1];
      return n ? s.v0 + s.t1 - s.t0 + ((t - s.t1) / (n.t0 - s.t1)) * GAP_W : s.v0 + s.t1 - s.t0;
    }
    return 0;
  };
  const toT = (v: number) => {
    for (let i = segs.length - 1; i >= 0; i--) {
      const s = segs[i];
      const len = s.t1 - s.t0;
      if (v < s.v0) continue;
      if (v <= s.v0 + len) return s.t0 + v - s.v0;
      const n = segs[i + 1];
      return n ? s.t1 + ((v - s.v0 - len) / GAP_W) * (n.t0 - s.t1) : s.t1;
    }
    return 0;
  };
  const gaps = segs.slice(1).map((n, i) => {
    const s = segs[i];
    const v0 = s.v0 + s.t1 - s.t0;
    return { v0, v1: n.v0, ms: n.t0 - s.t1 };
  });
  return { total, toV, toT, gaps, inGap: (t) => !segs.some((s) => t >= s.t0 && t <= s.t1) };
}
