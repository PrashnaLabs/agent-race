// Chapters: the prompts you typed and the git commits the agents made, as markers on the timeline.
import type { Agent, RaceEvent } from '../src/race.ts';
import { commandOf } from '../src/files.ts';

export type Chapter = { t: number; agent: Agent; kind: 'prompt' | 'commit'; title: string; ev: RaceEvent };

// Commit message from `git commit -m "..."` (first -m wins) or a heredoc `-m "$(cat <<'EOF' ... EOF)"`.
export function commitMessage(cmd: string): string | undefined {
  const at = cmd.search(/\bgit\s+(?:-C\s+\S+\s+)?commit\b/);
  if (at < 0) return undefined;
  const rest = cmd.slice(at);
  const heredoc = rest.match(/<<-?\s*'?"?(\w+)'?"?\s*\n\s*([^\n]+)/);
  if (heredoc) return heredoc[2].trim();
  const m = rest.match(/(?:-m|--message)(?:\s+|=)(["'])([\s\S]*?)\1/);
  if (m) return m[2].split('\n')[0].trim();
  return '(no message)';
}

export function chapters(events: RaceEvent[]): Chapter[] {
  const out: Chapter[] = [];
  for (const e of events) {
    if (e.kind === 'user') out.push({ t: e.t, agent: e.agent, kind: 'prompt', title: e.summary, ev: e });
    else if (e.kind === 'bash' && e.ok !== false) {
      const msg = commitMessage(commandOf(e.detail ?? '') || e.summary.replace(/^\$\s*/, ''));
      if (msg) out.push({ t: e.t, agent: e.agent, kind: 'commit', title: msg, ev: e });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}
