import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaude } from './adapters/claude.ts';
import { parseCodex } from './adapters/codex.ts';
import { buildRace, classifyCmd } from './race.ts';
import { fileTracker } from './files.ts';

const jsonl = (...rows: object[]) => rows.map((r) => JSON.stringify(r)).join('\n') + '\nnot json\n';

const claude = jsonl(
  { type: 'user', cwd: '/repo', timestamp: '2026-01-01T00:00:00Z', message: { content: 'fix the bug' } },
  { type: 'assistant', timestamp: '2026-01-01T00:01:00Z', message: { id: 'm1', model: 'claude-x', usage: { output_tokens: 50 }, content: [{ type: 'thinking', thinking: 'hmm' }] } },
  { type: 'assistant', timestamp: '2026-01-01T00:01:01Z', message: { id: 'm1', usage: { output_tokens: 50 }, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cd /repo && rg foo' } }] } },
  { type: 'user', timestamp: '2026-01-01T00:01:04Z', message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'boom' }] } },
  { type: 'assistant', timestamp: '2026-01-01T00:01:05Z', message: { id: 'm2', usage: { output_tokens: 10 }, content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/repo/a.ts' } }] } },
  { type: 'assistant', isSidechain: true, timestamp: '2026-01-01T00:01:06Z', message: { id: 'm3', content: [{ type: 'text', text: 'sub' }] } },
);

const codex = jsonl(
  { type: 'session_meta', timestamp: '2026-01-01T00:00:00Z', payload: { cwd: '/repo' } },
  { type: 'turn_context', timestamp: '2026-01-01T00:00:00Z', payload: { model: 'gpt-x' } },
  { type: 'response_item', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'message', role: 'user', content: [{ text: '<environment_context>' }] } },
  { type: 'response_item', timestamp: '2026-01-01T00:00:01Z', payload: { type: 'message', role: 'user', content: [{ text: 'fix the bug' }] } },
  { type: 'response_item', timestamp: '2026-01-01T00:00:02Z', payload: { type: 'reasoning', summary: [] } },
  { type: 'response_item', timestamp: '2026-01-01T00:00:03Z', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1', input: 'const r = await tools.exec_command({"cmd":"sed -n \'1,10p\' /repo/a.ts"})' } },
  { type: 'event_msg', timestamp: '2026-01-01T00:00:03Z', payload: { type: 'token_count', info: { last_token_usage: { output_tokens: 40 } } } },
  { type: 'response_item', timestamp: '2026-01-01T00:00:05Z', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: '[{"type":"input_text","text":"Script completed"}]' } },
  { type: 'response_item', timestamp: '2026-01-01T00:00:06Z', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', input: '*** Begin Patch\n*** Update File: /repo/a.ts\n' } },
);

test('claude adapter', () => {
  const p = parseClaude(claude);
  assert.equal(p.skipped, 1);
  assert.equal(p.model, 'claude-x');
  assert.deepEqual(p.events.map((e) => e.kind), ['user', 'thinking', 'search', 'edit']);
  assert.equal(p.events[1].tokens, 50); // counted once per message id
  assert.equal(p.events[2].tokens, undefined);
  assert.equal(p.events[2].ok, false);
  assert.equal(p.events[2].end! - p.events[2].ts, 3000);
});

test('codex adapter', () => {
  const p = parseCodex(codex);
  assert.equal(p.cwd, '/repo');
  assert.equal(p.model, 'gpt-x');
  assert.deepEqual(p.events.map((e) => e.kind), ['user', 'thinking', 'read', 'edit']);
  assert.equal(p.events[1].tokens, 40);
  assert.equal(p.events[2].ok, true);
  assert.equal(p.events[3].summary, 'patch /repo/a.ts');
});

test('buildRace removes human idle and strips cwd', () => {
  const r = buildRace({ claude: { file: 'c', parsed: parseClaude(claude) }, codex: { file: 'x', parsed: parseCodex(codex) } });
  const c = r.events.filter((e) => e.agent === 'claude');
  assert.equal(c[1].t, 60_000); // agent gap kept
  assert.equal(c[2].summary, '$ rg foo');
  assert.equal(c[3].summary, 'Edit a.ts');
  assert.equal(r.agents.claude?.totalTokens, 60);
  assert.equal(r.agents.codex?.steps, 4);
});

test('buildRace works with a single session', () => {
  const r = buildRace({ codex: { file: 'x', parsed: parseCodex(codex) } });
  assert.deepEqual(Object.keys(r.agents), ['codex']);
  assert.ok(r.events.every((e) => e.agent === 'codex'));
  assert.throws(() => buildRace({}));
});

test('events carry repo-relative files', () => {
  const r = buildRace({ claude: { file: 'c', parsed: parseClaude(claude) }, codex: { file: 'x', parsed: parseCodex(codex) } });
  const files = (a: string) => r.events.filter((e) => e.agent === a).flatMap((e) => e.files ?? []);
  assert.deepEqual(files('claude'), ['a.ts']);
  assert.deepEqual(files('codex'), ['a.ts', 'a.ts']);
});

test('fileTracker: Claude cd persists, resets on leaving project; Codex per command', () => {
  const sh = (cmd: string) => ({ kind: 'read' as const, summary: '$ x', detail: JSON.stringify({ command: cmd }) });
  const c = fileTracker('/repo', true);
  assert.deepEqual(c(sh('cd frontend && cat src/a.ts')), ['frontend/src/a.ts']);
  assert.deepEqual(c(sh('cat src/b.ts')), ['frontend/src/b.ts']); // cd carried over
  assert.deepEqual(c(sh('git add frontend/src/c.ts')), ['frontend/src/c.ts']); // already root-spelled
  assert.deepEqual(c(sh('S=/tmp/x; cat $S/jar.txt ${S}/b.txt; git show HEAD:web/a.ts')), ['web/a.ts']); // vars skipped
  c(sh('mkdir -p /tmp/s && cd /tmp/s && npm i')); // left the project: Claude Code resets to root
  assert.deepEqual(c(sh('cat src/d.ts')), ['src/d.ts']);
  assert.deepEqual(c(sh('cd /repo/web\nls src/x.ts')), ['web/src/x.ts']); // cd ended by newline
  assert.deepEqual(c(sh('cd .. && cat ../x.ts /etc/hosts.txt')), ['(outside)/x.ts', '(outside)/hosts.txt']);
  const x = fileTracker('/repo');
  assert.deepEqual(x({ kind: 'bash', summary: '$ x', detail: '{"cmd":"cat a.py","workdir":"/repo/api"}' }), ['api/a.py']);
  assert.deepEqual(x(sh('cd api && cat b.py')), ['api/b.py']);
  assert.deepEqual(x(sh('cat c.py')), ['c.py']); // no carry-over for Codex
  assert.deepEqual(x({ kind: 'thinking', summary: 'see a.py' }), []);
});

test('classifyCmd strips env + cd prefixes', () => {
  assert.equal(classifyCmd('FOO=1 cat x').kind, 'read');
  assert.equal(classifyCmd('cd a; cd b && pnpm test').kind, 'bash');
});
