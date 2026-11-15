// ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl -> RawEvent[]
import { classifyCmd, clip, firstLine, type Parsed, type RawEvent } from '../race.ts';

type Tool = Pick<RawEvent, 'kind' | 'tool' | 'summary' | 'detail'>;

const FAIL = /Script failed|exited with code [1-9]|Exit code: [1-9]|"exit_code":\s*[1-9]/i;

const outputText = (out: unknown): string => {
  if (typeof out !== 'string') return clip((out as any)?.content ?? out);
  try {
    const arr = JSON.parse(out);
    if (Array.isArray(arr)) return arr.map((x) => x?.text ?? '').join('\n');
  } catch {}
  return out;
};

// Codex wraps shell calls in a JS cell: `await tools.exec_command({"cmd":"..."})`.
function tool(name: string, raw: unknown): Tool {
  const src = typeof raw === 'string' ? raw : JSON.stringify(raw ?? '');
  const detail = clip(src);
  if (name === 'apply_patch' || src.includes('*** Begin Patch')) {
    const files = [...src.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n\\"]+)/g)].map((m) => m[1]);
    return { kind: 'edit', tool: 'apply_patch', summary: `patch ${files.join(', ')}`, detail };
  }
  const cmd = src.match(/"?cmd"?\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  if (cmd != null) {
    let c = cmd;
    try {
      c = JSON.parse(`"${cmd}"`);
    } catch {}
    return { ...classifyCmd(c), tool: name, detail };
  }
  try {
    const args = JSON.parse(src);
    if (Array.isArray(args?.command)) return { ...classifyCmd(args.command.join(' ')), tool: name, detail };
  } catch {}
  const inner = src.match(/tools\.(\w+)\(/)?.[1];
  if (inner === 'write_stdin') return { kind: 'bash', tool: inner, summary: 'poll running process', detail };
  if (inner?.startsWith('web')) {
    const q = src.match(/q"?\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
    return { kind: 'search', tool: inner, summary: `web ${q ?? ''}`.trim(), detail };
  }
  return { kind: 'tool', tool: inner ?? name, summary: inner ?? name, detail };
}

export function parseCodex(src: string): Parsed {
  const events: RawEvent[] = [];
  const pending = new Map<string, RawEvent>();
  let tokTarget: RawEvent | undefined; // first model output since last token_count
  let cwd = '';
  let model: string | undefined;
  let skipped = 0;

  for (const line of src.split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      skipped++;
      continue;
    }
    const p = o.payload ?? {};
    const ts = Date.parse(o.timestamp);
    if (o.type === 'session_meta') cwd ||= p.cwd ?? '';
    if (o.type === 'turn_context') model ??= p.model;
    if (o.type === 'event_msg' && p.type === 'token_count') {
      const n = p.info?.last_token_usage?.output_tokens;
      if (tokTarget && n) tokTarget.tokens = (tokTarget.tokens ?? 0) + n;
      tokTarget = undefined;
    }
    if (o.type !== 'response_item') continue;

    let e: RawEvent | undefined;
    switch (p.type) {
      case 'reasoning': {
        const s = (p.summary ?? []).map((x: any) => x?.text ?? '').join('\n');
        e = { ts, kind: 'thinking', summary: 'reasoning', detail: s ? clip(s) : undefined };
        break;
      }
      case 'message': {
        const t = (p.content ?? []).map((c: any) => c?.text ?? '').join('\n').trim();
        if (!t) break;
        if (p.role === 'assistant') e = { ts, kind: 'message', summary: firstLine(t), detail: clip(t) };
        else if (p.role === 'user' && !t.startsWith('<') && !t.startsWith('# AGENTS.md'))
          e = { ts, kind: 'user', summary: firstLine(t), detail: clip(t) };
        break;
      }
      case 'function_call':
      case 'custom_tool_call':
      case 'local_shell_call':
        e = { ts, ...tool(p.name ?? p.type, p.input ?? p.arguments ?? p.action) };
        if (p.call_id) pending.set(p.call_id, e);
        break;
      case 'function_call_output':
      case 'custom_tool_call_output':
      case 'local_shell_call_output': {
        const call = pending.get(p.call_id);
        if (!call) break;
        const out = outputText(p.output);
        call.end = ts;
        call.ok = !FAIL.test(out);
        call.detail = clip(`${call.detail ?? ''}\n\n── output ──\n${out}`);
        break;
      }
    }
    if (!e) continue;
    events.push(e);
    if (e.kind !== 'user') tokTarget ??= e;
  }
  return { events, cwd, model, skipped };
}
