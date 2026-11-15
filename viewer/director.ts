// Director camera: decide what the camera should frame, based on what each agent is doing right now.
import type { Agent, RaceEvent } from '../src/race.ts';
import { isCheck } from './report.ts';

// What deserves the camera: edits and failures first, then test runs, then reads/searches.
// Thinking and messages don't touch files, so they never pull the camera.
export const priority = (e?: RaceEvent) =>
  !e?.files?.length ? 0 : e.ok === false || e.kind === 'edit' ? 3 : isCheck(e) ? 2 : 1;

export type Focus = { agent: Agent; path: string; x: number; z: number; prio: number };
export type Shot = { kind: 'close' | 'two' | 'wide'; x: number; z: number; spread: number; focus: Focus[] };

// Frame both agents when they're doing equally important work far apart; otherwise close in on the
// most important action; wide when nobody is touching files.
export function pickShot(focus: Focus[], minSpread: number): Shot {
  const live = focus.filter((f) => f.prio > 0).sort((a, b) => b.prio - a.prio);
  if (!live.length) return { kind: 'wide', x: 0, z: 0, spread: 0, focus: [] };
  const [a, b] = live;
  if (b && a.prio === b.prio) {
    const spread = Math.hypot(a.x - b.x, a.z - b.z);
    if (spread > minSpread) return { kind: 'two', x: (a.x + b.x) / 2, z: (a.z + b.z) / 2, spread, focus: [a, b] };
  }
  return { kind: 'close', x: a.x, z: a.z, spread: 0, focus: [a] };
}

export const shotKey = (s: Shot) => `${s.kind}:${s.focus.map((f) => f.path).join('+')}`;
