// Repo-as-city layout: folders and files as a squarified treemap, plus per-file touch history.
import type { Agent, RaceEvent } from '../src/race.ts';

export const MAP_W = 64;
export const MAP_H = 38;

export type Rect = { x: number; y: number; w: number; h: number };
export type Metric = 'touches' | 'tokens' | 'time';
// tokens: share of the output tokens of the model response that made this call (split across files it touched)
// ms: share of the tool call's run time (split across files it touched)
export type Touch = { t: number; agent: Agent; edit: boolean; ev: RaceEvent; tokens: number; ms: number };
export type FileNode = {
  i: number; // instance index
  path: string;
  touches: Touch[]; // sorted by t
  readsAt: number[]; // reads so far after touches[k]
  editsAt: number[];
  tokAt: number[]; // cumulative estimated output tokens after touches[k]
  msAt: number[]; // cumulative tool time after touches[k]
  first: Partial<Record<Agent, number>>; // first touch time per agent
  weight: number;
  rect: Rect;
};
export type Group = { key: string; files: FileNode[]; weight: number; rect: Rect };
export type Hop = { t: number; file: FileNode };
export type CodeMap = {
  files: FileNode[];
  groups: Group[];
  byPath: Map<string, FileNode>;
  hops: Record<Agent, Hop[]>;
  max: Record<Metric, number>; // largest end-of-session value per metric, for scaling tile heights
};

// Value of a metric for a file after its first n touches. Edits weigh more than reads for `touches`.
export function metricValue(f: FileNode, n: number, metric: Metric): number {
  if (!n) return 0;
  if (metric === 'tokens') return f.tokAt[n - 1];
  if (metric === 'time') return f.msAt[n - 1];
  return f.readsAt[n - 1] + 3 * f.editsAt[n - 1];
}

// Squarified treemap (Bruls et al.): keeps tiles close to square so small files stay clickable.
export function squarify<T extends { weight: number }>(items: T[], x: number, y: number, w: number, h: number): (T & { rect: Rect })[] {
  const list = items.filter((i) => i.weight > 0).sort((a, b) => b.weight - a.weight) as (T & { rect: Rect })[];
  const total = list.reduce((s, i) => s + i.weight, 0);
  if (!total) return list;
  const scale = (w * h) / total;
  let rect = { x, y, w, h };
  let row: (T & { rect: Rect })[] = [];
  const worst = (r: T[], side: number) => {
    const areas = r.map((it) => it.weight * scale);
    const s = areas.reduce((a, b) => a + b, 0);
    return Math.max((side * side * Math.max(...areas)) / (s * s), (s * s) / (side * side * Math.min(...areas)));
  };
  const lay = (r: (T & { rect: Rect })[]) => {
    const s = r.reduce((a, it) => a + it.weight * scale, 0);
    if (rect.w >= rect.h) {
      const cw = s / rect.h;
      let cy = rect.y;
      for (const it of r) {
        const rh = (it.weight * scale) / cw;
        it.rect = { x: rect.x, y: cy, w: cw, h: rh };
        cy += rh;
      }
      rect = { x: rect.x + cw, y: rect.y, w: rect.w - cw, h: rect.h };
    } else {
      const rh = s / rect.w;
      let cx = rect.x;
      for (const it of r) {
        const rw = (it.weight * scale) / rh;
        it.rect = { x: cx, y: rect.y, w: rw, h: rh };
        cx += rw;
      }
      rect = { x: rect.x, y: rect.y + rh, w: rect.w, h: rect.h - rh };
    }
  };
  for (let i = 0; i < list.length; ) {
    const side = Math.min(rect.w, rect.h);
    if (!row.length || worst([...row, list[i]], side) <= worst(row, side)) row.push(list[i++]);
    else {
      lay(row);
      row = [];
    }
  }
  if (row.length) lay(row);
  return list;
}

// Folder key: up to 2 levels deep, so the map shows ~10-30 districts instead of hundreds.
const groupOf = (path: string) => {
  const parts = path.split('/');
  return parts.length > 1 ? parts.slice(0, Math.min(2, parts.length - 1)).join('/') : '(root)';
};

export function buildCodeMap(events: RaceEvent[], agents: Agent[]): CodeMap {
  const byPath = new Map<string, FileNode>();
  const touchesOf = new Map<RaceEvent, Touch[]>();
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    const paths = e.files ?? [];
    const mine: Touch[] = [];
    for (const path of paths) {
      let f = byPath.get(path);
      if (!f)
        byPath.set(path, (f = { i: byPath.size, path, touches: [], readsAt: [], editsAt: [], tokAt: [], msAt: [], first: {}, weight: 0, rect: { x: 0, y: 0, w: 0, h: 0 } }));
      const touch = { t: e.t, agent: e.agent, edit: e.kind === 'edit', ev: e, tokens: 0, ms: e.dur / paths.length };
      f.touches.push(touch);
      mine.push(touch);
    }
    if (mine.length) touchesOf.set(e, mine);
  }

  // Tokens are logged per model response (on its first event). A response owns every tool call until
  // the next response, so its output tokens are split evenly across the files those calls touched.
  for (const a of agents) {
    let turn: { tokens: number; touches: Touch[] } | null = null;
    const flush = () => turn?.touches.forEach((x) => (x.tokens = turn!.tokens / turn!.touches.length));
    for (const e of events.filter((x) => x.agent === a).sort((x, y) => x.step - y.step)) {
      if (e.tokens) {
        flush();
        turn = { tokens: e.tokens, touches: [] };
      }
      turn?.touches.push(...(touchesOf.get(e) ?? []));
    }
    flush();
  }

  const files = [...byPath.values()];
  const max: Record<Metric, number> = { touches: 0, tokens: 0, time: 0 };
  for (const f of files) {
    let r = 0;
    let ed = 0;
    let tok = 0;
    let ms = 0;
    for (const x of f.touches) {
      if (x.edit) ed++;
      else r++;
      tok += x.tokens;
      ms += x.ms;
      f.readsAt.push(r);
      f.editsAt.push(ed);
      f.tokAt.push(tok);
      f.msAt.push(ms);
      f.first[x.agent] ??= x.t;
    }
    f.weight = 1 + Math.sqrt(f.touches.length) * 2;
    for (const m of ['touches', 'tokens', 'time'] as const) max[m] = Math.max(max[m], metricValue(f, f.touches.length, m));
  }

  const groupMap = new Map<string, Group>();
  for (const f of files) {
    const key = groupOf(f.path);
    let g = groupMap.get(key);
    if (!g) groupMap.set(key, (g = { key, files: [], weight: 0, rect: { x: 0, y: 0, w: 0, h: 0 } }));
    g.files.push(f);
    g.weight += f.weight;
  }
  const groups = squarify([...groupMap.values()], -MAP_W / 2, -MAP_H / 2, MAP_W, MAP_H);
  for (const g of groups) {
    const r = g.rect;
    // inset leaves room for the folder label along the top edge
    squarify(g.files, r.x + 0.5, r.y + 1, Math.max(r.w - 1, 0.2), Math.max(r.h - 1.5, 0.2));
  }

  const hops = {} as Record<Agent, Hop[]>;
  for (const a of agents)
    hops[a] = events
      .filter((e) => e.agent === a && e.files?.length)
      .sort((x, y) => x.t - y.t)
      .map((e) => ({ t: e.t, file: byPath.get(e.files![0])! }));
  return { files, groups, byPath, hops, max };
}

// Count of items with t <= time (items sorted by t).
export function upper<T extends { t: number }>(arr: T[], time: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
