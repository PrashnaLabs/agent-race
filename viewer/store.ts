import { create } from 'zustand';
import { agentsIn, type Agent, type AgentMeta, type Kind, type Race, type RaceEvent } from '../src/race.ts';
import { makeAxis, type Axis } from './axis.ts';
import { buildCodeMap, type CodeMap, type FileNode, type Metric } from './codemap.ts';
import { jump } from './report.ts';
import { chapters, type Chapter } from './chapters.ts';

export type Cam = 'overview' | 'follow' | 'top' | 'director';

export const KIND_COLOR: Record<Kind, string> = {
  user: '#facc15',
  thinking: '#a78bfa',
  message: '#e2e8f0',
  read: '#60a5fa',
  search: '#22d3ee',
  edit: '#4ade80',
  bash: '#fb923c',
  tool: '#f472b6',
};
export const FAIL_COLOR = '#ef4444';
export const AGENT_COLOR: Record<Agent, string> = { claude: '#e8825f', codex: '#7dd3fc' };
export const AGENT_NAME: Record<Agent, string> = { claude: 'Claude Code', codex: 'Codex' };
export const SPEEDS = [1, 10, 50, 200, 1000];
export const evColor = (e: RaceEvent) => (e.ok === false ? FAIL_COLOR : KIND_COLOR[e.kind]);

export type Lane = { events: RaceEvent[]; cumTokens: number[] };
export type Hover = { ev?: RaceEvent; file?: FileNode; x: number; y: number };

type State = {
  race: Race;
  agents: Agent[]; // present in this race: 1 (solo) or 2
  meta: Record<Agent, AgentMeta>; // only keys in `agents` are set
  lanes: Record<Agent, Lane>;
  map: CodeMap;
  maxMs: number;
  collapse: boolean;
  axis: Axis;
  time: number; // real ms
  playing: boolean;
  speed: number;
  cam: Cam;
  tlH: number; // timeline panel height in px; tall enough = full swimlanes
  metric: Metric; // what tile height shows
  editsOnly: boolean; // hide files that were only read
  report: boolean; // report card open
  reportSeen: boolean; // auto-opened once at the end of playback
  byTime: RaceEvent[]; // all agents' events sorted by time (jump keys)
  shot: string; // director camera caption
  chapters: Chapter[]; // prompts + git commits, by time
  chapterIds: Set<string>; // event ids that are chapters (C key)
  hidden: Kind[];
  selected: RaceEvent | null;
  selFile: FileNode | null;
  hover: Hover | null;
  set: (p: Partial<State>) => void;
};

export function lanesOf(race: Race): Record<Agent, Lane> {
  const out = {} as Record<Agent, Lane>;
  for (const a of agentsIn(race)) {
    const events = race.events.filter((e) => e.agent === a).sort((x, y) => x.step - y.step);
    let sum = 0;
    out[a] = { events, cumTokens: events.map((e) => (sum += e.tokens ?? 0)) };
  }
  return out;
}

export const useRace = create<State>()((set) => ({
  // set by init() before first render
  race: null as unknown as Race,
  agents: [],
  meta: null as unknown as Record<Agent, AgentMeta>,
  lanes: null as unknown as Record<Agent, Lane>,
  map: null as unknown as CodeMap,
  axis: null as unknown as Axis,
  maxMs: 1,
  collapse: true,
  time: 0,
  playing: false,
  speed: 50,
  cam: 'overview',
  tlH: storedTlH(),
  metric: 'touches',
  editsOnly: false,
  report: false,
  reportSeen: false,
  byTime: [],
  shot: '',
  chapters: [],
  chapterIds: new Set(),
  hidden: [],
  selected: null,
  selFile: null,
  hover: null,
  set: (p) => set(p),
}));

// Timeline panel sizing. Above TL_FULL the strip turns into labeled, zoomable swimlanes.
export const TL_MIN = 96;
export const TL_DEFAULT = 190;
export const TL_FULL = 320;
const TL_KEY = 'agent-race:tlH';
export const tlMax = () => Math.max(TL_FULL, innerHeight - 100); // leave room for controls + a top margin
export const isFull = (h: number) => h >= TL_FULL;
function storedTlH() {
  try {
    const v = Number(localStorage.getItem(TL_KEY));
    return v ? Math.min(Math.max(v, TL_MIN), tlMax()) : TL_DEFAULT;
  } catch {
    return TL_DEFAULT;
  }
}
export function setTlH(h: number) {
  const tlH = Math.round(Math.min(Math.max(h, TL_MIN), tlMax()));
  useRace.getState().set({ tlH });
  try {
    localStorage.setItem(TL_KEY, String(tlH));
  } catch {} // per-viewer convenience only
}
export const toggleLanes = () => setTlH(isFull(useRace.getState().tlH) ? TL_DEFAULT : tlMax());

export function setCollapse(collapse: boolean) {
  const s = useRace.getState();
  s.set({ collapse, axis: makeAxis(s.race.events, s.maxMs, collapse) });
}

export function init(race: Race) {
  // Deep link: #t=<ms>&cam=overview|follow|top|director&lanes=1&h=touches|lines|tokens|time&edits=1
  const h = new URLSearchParams(location.hash.slice(1));
  const cam = h.get('cam') as Cam | null;
  const agents = agentsIn(race);
  const meta = race.agents as Record<Agent, AgentMeta>;
  const maxMs = Math.max(1, ...agents.map((a) => meta[a].totalMs));
  const axis = makeAxis(race.events, maxMs, true);
  useRace.setState({
    race,
    agents,
    meta,
    lanes: lanesOf(race),
    byTime: [...race.events].sort((a, b) => a.t - b.t),
    ...(() => {
      const cs = chapters(race.events);
      return { chapters: cs, chapterIds: new Set(cs.map((c) => c.ev.id)) };
    })(),
    map: buildCodeMap(race.events, agents),
    maxMs,
    axis,
    time: Number(h.get('t')) || 0,
    ...(cam && ['overview', 'follow', 'top', 'director'].includes(cam) && { cam }),
    ...(h.get('lanes') === '1' && { tlH: tlMax() }),
    editsOnly: h.get('edits') === '1',
    ...(['touches', 'lines', 'tokens', 'time'].includes(h.get('h') ?? '') && { metric: h.get('h') as Metric }),
    // Replay the (idle-collapsed) session in ~45s.
    speed: SPEEDS.find((s) => axis.total / s <= 45_000) ?? SPEEDS.at(-1)!,
  });
}

// Index of last event started at or before `time`, -1 if none.
export function idxAt(events: RaceEvent[], time: number): number {
  let lo = 0;
  let hi = events.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (events[mid].t <= time) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

export const fmtMs = (ms: number) => {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};
export const fmtTok = (n: number) => (n < 1000 ? String(Math.round(n)) : n < 1e6 ? `${(n / 1000).toFixed(1)}k` : `${(n / 1e6).toFixed(2)}M`);
export const fmtDur = (ms: number) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : fmtMs(ms));

// Seek relative to the visual axis (so idle gaps don't swallow arrow-key presses).
export function seekBy(frac: number) {
  const s = useRace.getState();
  const v = Math.min(s.axis.total, Math.max(0, s.axis.toV(s.time) + frac * s.axis.total));
  s.set({ time: s.axis.toT(v) });
}
// Move the playhead to the next/previous event matching `pred` and open it.
export function jumpTo(pred: (e: RaceEvent) => boolean, dir: 1 | -1) {
  const s = useRace.getState();
  const e = jump(s.byTime, s.time, pred, dir);
  if (e) s.set({ time: e.t, playing: false, selected: e, selFile: null });
}

export function togglePlay() {
  const s = useRace.getState();
  s.set({ playing: !s.playing, time: !s.playing && s.axis.toV(s.time) >= s.axis.total - 1 ? 0 : s.time });
}
