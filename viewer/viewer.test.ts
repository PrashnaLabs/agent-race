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

test('actions describe what the agent is doing', async () => {
  const { actionText } = await import('./actions.ts');
  const ev = (kind: RaceEvent['kind'], summary: string, extra: Partial<RaceEvent> = {}): RaceEvent =>
    ({ id: 'x', agent: 'claude', t: 0, dur: 0, step: 0, kind, summary, ...extra });
  assert.equal(actionText(ev('edit', 'Edit src/app.ts', { files: ['src/app.ts'] })), '✎ editing app.ts');
  assert.equal(actionText(ev('read', '$ cat a b', { files: ['src/a.ts', 'src/b.ts'] })), '◉ reading a.ts +1');
  assert.equal(actionText(ev('search', 'Grep highlight(')), '⌕ searching highlight(');
  assert.equal(actionText(ev('bash', '$ pnpm test')), '▶ running pnpm test');
  assert.equal(actionText(ev('thinking', 'thinking')), '… thinking');
});

test('lines metric sums lines added + removed per file, split across multi-file edits', () => {
  const ev = (step: number, files: string[], added: number, removed: number): RaceEvent =>
    ({ id: `c${step}`, agent: 'claude', t: step, dur: 1, step, kind: 'edit', summary: '', files, added, removed });
  const m = buildCodeMap([ev(0, ['a.ts'], 10, 2), ev(1, ['a.ts', 'b.ts'], 4, 4)], ['claude']);
  assert.equal(metricValue(m.byPath.get('a.ts')!, 2, 'lines'), 12 + 4);
  assert.equal(metricValue(m.byPath.get('b.ts')!, 1, 'lines'), 4);
  assert.equal(m.max.lines, 16);
});

test('report stats and jump lookups', async () => {
  const { stats, jump, isCheck, isEdit, isError } = await import('./report.ts');
  const ev = (t: number, kind: RaceEvent['kind'], extra: Partial<RaceEvent> = {}): RaceEvent =>
    ({ id: `e${t}`, agent: 'claude', t, dur: 10, step: t, kind, summary: '', ...extra });
  const events = [
    ev(0, 'read', { files: ['a.ts'] }),
    ev(100, 'edit', { files: ['a.ts'], added: 5, removed: 1, tokens: 50 }),
    ev(200, 'bash', { summary: '$ pnpm test', ok: false }),
    ev(300, 'bash', { summary: '$ pnpm test', ok: true }),
    ev(400, 'edit', { files: ['b.ts'], added: 2, removed: 0 }),
  ];
  const map = buildCodeMap(events, ['claude']);
  const s = stats(events, map, 'claude');
  assert.deepEqual(
    [s.steps, s.filesTouched, s.filesEdited, s.added, s.removed, s.errors, s.checks, s.checksFailed, s.tokens, s.ms],
    [5, 2, 2, 7, 1, 1, 2, 1, 50, 410],
  );
  assert.equal(stats(events, map, 'claude', 150).filesEdited, 1); // playhead-aware
  assert.ok(isCheck(events[2]) && !isCheck(ev(0, 'bash', { summary: '$ ls' })));
  assert.equal(jump(events, 100, isEdit, 1)?.t, 400);
  assert.equal(jump(events, 400, isEdit, -1)?.t, 100);
  assert.equal(jump(events, 250, isError, 1), undefined);
});

test('isCheck matches test/lint runners as commands, not test file names', async () => {
  const { isCheck } = await import('./report.ts');
  const b = (summary: string): RaceEvent => ({ id: 'b', agent: 'claude', t: 0, dur: 0, step: 0, kind: 'bash', summary });
  for (const yes of ['$ pnpm test', '$ pnpm exec vitest run src/app', '$ uv run pytest tests/unit -q', '$ npx tsc --noEmit', '$ go test ./...', '$ npm run lint'])
    assert.ok(isCheck(b(yes)), yes);
  for (const no of ['$ grep -n x src/app/globals.contrast.test.ts', '$ cat jest.config.js', '$ ls tests/', '$ git status'])
    assert.ok(!isCheck(b(no)), no);
});

test('director picks close-up / two-shot / wide from current actions', async () => {
  const { pickShot, priority } = await import('./director.ts');
  const ev = (kind: RaceEvent['kind'], extra: Partial<RaceEvent> = {}): RaceEvent =>
    ({ id: 'e', agent: 'claude', t: 0, dur: 0, step: 0, kind, summary: '', ...extra });
  assert.equal(priority(ev('edit', { files: ['a'] })), 3);
  assert.equal(priority(ev('bash', { files: ['a'], ok: false })), 3);
  assert.equal(priority(ev('bash', { files: ['a'], summary: '$ pnpm test' })), 2);
  assert.equal(priority(ev('read', { files: ['a'] })), 1);
  assert.equal(priority(ev('thinking')), 0);
  const f = (agent: 'claude' | 'codex', x: number, prio: number) => ({ agent, path: `${agent}.ts`, x, z: 0, prio });
  assert.equal(pickShot([f('claude', 0, 0), f('codex', 5, 0)], 6).kind, 'wide');
  const close = pickShot([f('claude', 0, 3), f('codex', 20, 1)], 6);
  assert.deepEqual([close.kind, close.focus[0].agent], ['close', 'claude']); // edit beats read
  const two = pickShot([f('claude', 0, 3), f('codex', 20, 3)], 6);
  assert.deepEqual([two.kind, two.x], ['two', 10]);
  assert.equal(pickShot([f('claude', 0, 3), f('codex', 2, 3)], 6).kind, 'close'); // too close for a two-shot
});
