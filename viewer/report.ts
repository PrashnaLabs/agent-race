// Session outcome stats (report card) and "jump to next edit / error / test" lookups.
import type { Agent, RaceEvent } from '../src/race.ts';
import type { CodeMap } from './codemap.ts';

// ponytail: command-name heuristic for test/typecheck/lint runs; misses custom scripts (e.g. `make ci`).
// The runner must appear as a command word, so `grep foo src/x.test.ts` or `cat jest.config.js` don't count.
const RUNNER = String.raw`(?:pytest|vitest|jest|mocha|playwright|tsc|eslint|ruff|mypy)`;
const SCRIPT = String.raw`(?:(?:pnpm|npm|yarn|bun)(?:\s+run)?\s+(?:test|typecheck|lint|check)|go\s+test|cargo\s+test|make\s+(?:test|check|lint))`;
const CHECK = new RegExp(String.raw`(?:^|[\s;&|(])(?:${RUNNER}|${SCRIPT})(?=\s|$|;|&|\|)`, 'i');
export const isCheck = (e: RaceEvent) => e.kind === 'bash' && CHECK.test(e.summary);
export const isError = (e: RaceEvent) => e.ok === false;
export const isEdit = (e: RaceEvent) => e.kind === 'edit';

export type Stats = {
  ms: number;
  steps: number;
  filesTouched: number;
  filesEdited: number;
  added: number;
  removed: number;
  errors: number;
  checks: number;
  checksFailed: number;
  tokens: number;
};

export function stats(events: RaceEvent[], map: CodeMap, agent: Agent, time = Infinity): Stats {
  const done = events.filter((e) => e.t <= time);
  const last = done.at(-1);
  const touched = map.files.filter((f) => f.touches.some((x) => x.agent === agent && x.t <= time));
  const checks = done.filter(isCheck);
  return {
    ms: last ? Math.min(time, last.t + last.dur) : 0,
    steps: done.length,
    filesTouched: touched.length,
    filesEdited: touched.filter((f) => f.touches.some((x) => x.agent === agent && x.edit && x.t <= time)).length,
    added: done.reduce((n, e) => n + (e.added ?? 0), 0),
    removed: done.reduce((n, e) => n + (e.removed ?? 0), 0),
    errors: done.filter(isError).length,
    checks: checks.length,
    checksFailed: checks.filter(isError).length,
    tokens: done.reduce((n, e) => n + (e.tokens ?? 0), 0),
  };
}

// Next (dir 1) or previous (dir -1) event matching `pred`, relative to `time`. `events` sorted by t.
export function jump(events: RaceEvent[], time: number, pred: (e: RaceEvent) => boolean, dir: 1 | -1): RaceEvent | undefined {
  if (dir === 1) return events.find((e) => e.t > time + 1 && pred(e));
  for (let i = events.length - 1; i >= 0; i--) if (events[i].t < time - 1 && pred(events[i])) return events[i];
  return undefined;
}
