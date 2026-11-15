// Shared contract between CLI adapters and the 3D viewer.
import { fileTracker } from './files.ts';

export const KINDS = ['user', 'thinking', 'message', 'read', 'search', 'edit', 'bash', 'tool'] as const;
export type Kind = (typeof KINDS)[number];
export type Agent = 'claude' | 'codex';
export const AGENTS: Agent[] = ['claude', 'codex'];

export type RaceEvent = {
  id: string;
  agent: Agent;
  t: number; // ms since that agent's first event (human idle removed)
  dur: number; // tool: call -> result; otherwise gap to next event
  step: number; // index within agent
  kind: Kind;
  tool?: string;
  summary: string;
  detail?: string;
  tokens?: number; // output tokens of the model turn that produced this event
  ok?: boolean;
  files?: string[]; // repo-relative paths this event read/edited/searched (code map)
};

export type AgentMeta = {
  file: string;
  cwd: string;
  model?: string;
  startedAt: string;
  totalMs: number;
  totalTokens: number;
  steps: number;
  skipped: number;
};

// One agent (solo replay) or both (race).
export type Race = { version: 1; agents: Partial<Record<Agent, AgentMeta>>; events: RaceEvent[] };

export const agentsIn = (race: Race): Agent[] => AGENTS.filter((a) => race.agents[a]);

// What an adapter produces: absolute timestamps, no ordering guarantees.
export type RawEvent = Omit<RaceEvent, 'id' | 'agent' | 't' | 'dur' | 'step'> & { ts: number; end?: number };
export type Parsed = { events: RawEvent[]; cwd: string; model?: string; skipped: number };

// Gap before a user message is the human thinking, not the agent working.
const USER_IDLE_CAP = 2_000;
// ponytail: flat 10 min cap on any other gap (sleep, usage-limit waits); smarter idle detection if needed.
const GAP_CAP = 10 * 60_000;
// Messages/thinking are instants; the gap after one is the next model call, not the event itself.
const INSTANT_CAP = 15_000;
const DETAIL_MAX = 4_000;

export const clip = (s: unknown, n = DETAIL_MAX): string => {
  const str = typeof s === 'string' ? s : s == null ? '' : JSON.stringify(s, null, 2);
  return str.length > n ? `${str.slice(0, n)}\n… (${str.length - n} more chars)` : str;
};

export const firstLine = (s: string, n = 120): string => {
  const l = s.trim().split('\n')[0] ?? '';
  return l.length > n ? `${l.slice(0, n)}…` : l;
};

const READ_CMDS = new Set(['cat', 'sed', 'head', 'tail', 'ls', 'nl', 'wc', 'less', 'tree', 'bat', 'file', 'stat', 'jq', 'pwd']);
const SEARCH_CMDS = new Set(['rg', 'grep', 'find', 'fd', 'ag']);

// Shell commands from either agent land in the same buckets so the race is fair.
export function classifyCmd(cmd: string): { kind: Kind; summary: string } {
  const c = cmd
    .trim()
    .replace(/^(cd\s+[^&;]+(&&|;)\s*)+/, '')
    .replace(/^([A-Z_][A-Z0-9_]*=\S+\s+)+/, '');
  const word = (c.split(/\s+/)[0] ?? '').split('/').pop() ?? '';
  const kind: Kind = SEARCH_CMDS.has(word) ? 'search' : READ_CMDS.has(word) ? 'read' : 'bash';
  return { kind, summary: `$ ${firstLine(c)}` };
}

export function finalize(agent: Agent, file: string, p: Parsed): { meta: AgentMeta; events: RaceEvent[] } {
  const raw = p.events.filter((e) => Number.isFinite(e.ts)).sort((a, b) => a.ts - b.ts);
  const strip = (s: string) => (p.cwd ? s.replaceAll(`${p.cwd}/`, '') : s);
  const filesOf = fileTracker(p.cwd, agent === 'claude'); // stateful: must see events in order
  let t = 0;
  const ts: number[] = raw.map((e, i) => {
    if (i) t += Math.min(e.ts - raw[i - 1].ts, e.kind === 'user' ? USER_IDLE_CAP : GAP_CAP);
    return t;
  });
  const events = raw.map((e, i): RaceEvent => {
    const files = filesOf(e);
    const { ts: _ts, end, ...rest } = e;
    const next = i + 1 < raw.length ? ts[i + 1] - ts[i] : 0;
    return {
      ...rest,
      summary: strip(e.summary),
      ...(files.length ? { files } : {}),
      id: `${agent}-${i}`,
      agent,
      t: ts[i],
      dur: end != null ? Math.min(Math.max(end - e.ts, 0), GAP_CAP) : Math.min(next, INSTANT_CAP),
      step: i,
    };
  });
  const last = events.at(-1);
  return {
    events,
    meta: {
      file,
      cwd: p.cwd,
      model: p.model,
      startedAt: raw[0] ? new Date(raw[0].ts).toISOString() : '',
      totalMs: last ? last.t + last.dur : 0,
      totalTokens: events.reduce((s, e) => s + (e.tokens ?? 0), 0),
      steps: events.length,
      skipped: p.skipped,
    },
  };
}

export function buildRace(sides: Partial<Record<Agent, { file: string; parsed: Parsed }>>): Race {
  const race: Race = { version: 1, agents: {}, events: [] };
  for (const a of AGENTS) {
    const side = sides[a];
    if (!side) continue;
    const { meta, events } = finalize(a, side.file, side.parsed);
    race.agents[a] = meta;
    race.events.push(...events);
  }
  if (!race.events.length) throw new Error('No events found in the given session(s).');
  return race;
}
