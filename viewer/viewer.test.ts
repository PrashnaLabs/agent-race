import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeAxis } from './axis.ts';
import { buildCodeMap, metricValue, squarify, upper } from './codemap.ts';
import type { RaceEvent } from '../src/race.ts';

test('axis squeezes idle gaps and round-trips', () => {
  const ax = makeAxis([{ t: 0, dur: 1000 }, { t: 600_000, dur: 1000 }], 601_500, true);
  assert.ok(ax.total < 20_000, `total ${ax.total}`); // 10 min idle -> 5s
  assert.equal(ax.gaps.length, 1);
  for (const t of [0, 500, 300_000, 600_500]) assert.ok(Math.abs(ax.toT(ax.toV(t)) - t) < 1e-6);
  assert.ok(ax.inGap(300_000));
  assert.equal(makeAxis([], 1000, false).total, 1000);
});

test('squarify fills the rect with no overlap', () => {
  const out = squarify([{ weight: 6 }, { weight: 3 }, { weight: 2 }, { weight: 1 }], 0, 0, 12, 8);
  const area = out.reduce((s, i) => s + i.rect.w * i.rect.h, 0);
  assert.ok(Math.abs(area - 96) < 1e-9);
  for (const a of out) for (const b of out) {
    if (a === b) continue;
    const overlap = Math.max(0, Math.min(a.rect.x + a.rect.w, b.rect.x + b.rect.w) - Math.max(a.rect.x, b.rect.x)) *
      Math.max(0, Math.min(a.rect.y + a.rect.h, b.rect.y + b.rect.h) - Math.max(a.rect.y, b.rect.y));
    assert.ok(overlap < 1e-9);
  }
});

test('codemap tracks touches per file and agent hops', () => {
  const ev = (agent: 'claude' | 'codex', t: number, kind: RaceEvent['kind'], files: string[]): RaceEvent =>
    ({ id: `${agent}${t}`, agent, t, dur: 1, step: t, kind, summary: '', files });
  const m = buildCodeMap([ev('claude', 1, 'read', ['src/a.ts']), ev('codex', 2, 'edit', ['src/a.ts']), ev('claude', 3, 'edit', ['b.md'])], ['claude', 'codex']);
  const a = m.byPath.get('src/a.ts')!;
  assert.deepEqual([a.readsAt.at(-1), a.editsAt.at(-1)], [1, 1]);
  assert.deepEqual(a.first, { claude: 1, codex: 2 });
  assert.deepEqual(m.hops.claude.map((h) => h.file.path), ['src/a.ts', 'b.md']);
  assert.deepEqual(m.groups.map((g) => g.key).sort(), ['(root)', 'src']);
  assert.equal(upper(a.touches, 1.5), 1);
});

test('codemap splits response tokens across touched files and tool time per file', () => {
  const ev = (step: number, kind: RaceEvent['kind'], extra: Partial<RaceEvent>): RaceEvent =>
    ({ id: `c${step}`, agent: 'claude', t: step * 1000, dur: 0, step, kind, summary: '', ...extra });
  const m = buildCodeMap(
    [
      ev(0, 'thinking', { tokens: 300 }), // response 1: thinking + two tool calls
      ev(1, 'read', { files: ['a.ts'], dur: 2000 }),
      ev(2, 'search', { files: ['a.ts', 'b.ts'], dur: 1000 }),
      ev(3, 'edit', { files: ['b.ts'], tokens: 90, dur: 4000 }), // response 2: tokens on the tool call itself
    ],
    ['claude'],
  );
  const a = m.byPath.get('a.ts')!;
  const b = m.byPath.get('b.ts')!;
  // response 1 = 300 tok over 3 touches (a, a, b) -> 100 each; response 2 = 90 tok on b
  assert.equal(metricValue(a, a.touches.length, 'tokens'), 200);
  assert.equal(metricValue(b, b.touches.length, 'tokens'), 190);
  assert.equal(metricValue(a, a.touches.length, 'time'), 2500); // 2000 + 1000/2
  assert.equal(metricValue(b, b.touches.length, 'time'), 4500);
  assert.equal(metricValue(b, 1, 'tokens'), 100); // cumulative, playback-aware
  assert.equal(m.max.tokens, 200);
  assert.equal(metricValue(b, 2, 'touches'), 1 + 3); // 1 read + 1 edit (x3)
});

test('files touched by both agents split into time-ordered runs', () => {
  const ev = (agent: 'claude' | 'codex', t: number, kind: RaceEvent['kind']): RaceEvent =>
    ({ id: `${agent}${t}`, agent, t, dur: 1, step: t, kind, summary: '', files: ['style.css'] });
  const m = buildCodeMap(
    [ev('codex', 1, 'edit'), ev('codex', 2, 'read'), ev('claude', 3, 'read'), ev('claude', 4, 'edit'), ev('codex', 5, 'edit')],
    ['claude', 'codex'],
  );
  const f = m.byPath.get('style.css')!;
  assert.deepEqual(f.runs.map((r) => [r.agent, r.start, r.end]), [['codex', 0, 2], ['claude', 2, 4], ['codex', 4, 5]]);
  assert.equal(m.runs.length, 3);
});
