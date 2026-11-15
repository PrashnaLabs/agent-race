// ~/.claude/projects/<cwd>/<session>.jsonl -> RawEvent[]
import { classifyCmd, clip, firstLine, type Parsed, type RawEvent } from '../race.ts';

type Tool = Pick<RawEvent, 'kind' | 'tool' | 'summary' | 'detail'>;

const text = (c: unknown): string =>
  typeof c === 'string'
    ? c
    : Array.isArray(c)
      ? c.map((b) => (b?.type === 'text' ? b.text : b?.type === 'image' ? '[image]' : '')).join('\n')
      : '';

function tool(name: string, input: Record<string, unknown>): Tool {
  const s = (v: unknown) => String(v ?? '');
  const detail = clip(input);
  switch (name) {
    case 'Read':
      return { kind: 'read', tool: name, summary: `Read ${s(input.file_path)}`, detail };
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { kind: 'edit', tool: name, summary: `${name} ${s(input.file_path ?? input.notebook_path)}`, detail };
    case 'Bash':
      return { ...classifyCmd(s(input.command)), tool: name, detail };
    case 'Grep':
    case 'Glob':
    case 'WebSearch':
    case 'WebFetch':
      return { kind: 'search', tool: name, summary: `${name} ${s(input.pattern ?? input.query ?? input.url)}`, detail };
    default:
      return { kind: 'tool', tool: name, summary: name, detail };
  }
}

export function parseClaude(src: string): Parsed {
  const events: RawEvent[] = [];
  const pending = new Map<string, RawEvent>();
  const seenMsg = new Set<string>();
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
    if (o.isSidechain) continue;
    cwd ||= o.cwd ?? '';
    const ts = Date.parse(o.timestamp);

    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      model ??= o.message.model;
      // One API message is split across several lines, each repeating usage. Count it once.
      const mid = o.message.id;
      let tokens: number | undefined;
      if (mid && !seenMsg.has(mid)) {
        seenMsg.add(mid);
        tokens = o.message.usage?.output_tokens;
      }
      for (const b of o.message.content) {
        let e: RawEvent | undefined;
        if (b.type === 'thinking') e = { ts, kind: 'thinking', summary: 'thinking', detail: clip(b.thinking) };
        else if (b.type === 'text' && b.text?.trim()) e = { ts, kind: 'message', summary: firstLine(b.text), detail: clip(b.text) };
        else if (b.type === 'tool_use') {
          e = { ts, ...tool(b.name, b.input ?? {}) };
          pending.set(b.id, e);
        }
        if (!e) continue;
        if (tokens) {
          e.tokens = tokens;
          tokens = undefined;
        }
        events.push(e);
      }
    } else if (o.type === 'user' && !o.isMeta) {
      const c = o.message?.content;
      if (Array.isArray(c) && c.some((b) => b?.type === 'tool_result')) {
        for (const b of c) {
          const e = b?.type === 'tool_result' && pending.get(b.tool_use_id);
          if (!e) continue;
          e.end = ts;
          e.ok = !b.is_error;
          e.detail = clip(`${e.detail ?? ''}\n\n── output ──\n${text(b.content)}`);
        }
      } else {
        const t = text(c).trim();
        if (t && !t.startsWith('<')) events.push({ ts, kind: 'user', summary: firstLine(t), detail: clip(t) });
      }
    }
  }
  return { events, cwd, model, skipped };
}
