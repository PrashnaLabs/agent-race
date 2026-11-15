// Human-readable "what is the agent doing" for an event: icon + verb + target.
import type { RaceEvent } from '../src/race.ts';

export type Action = { icon: string; verb: string; target: string };

const base = (p: string) => p.split('/').pop() ?? p;
const filesTarget = (files: string[]) => base(files[0]) + (files.length > 1 ? ` +${files.length - 1}` : '');
const strip = (s: string, re: RegExp) => s.replace(re, '').trim();

export function describe(e: RaceEvent): Action {
  const files = e.files ?? [];
  switch (e.kind) {
    case 'edit':
      return { icon: '✎', verb: 'editing', target: files.length ? filesTarget(files) : strip(e.summary, /^(Edit|Write|MultiEdit|NotebookEdit|patch)\s*/) };
    case 'read':
      return { icon: '◉', verb: 'reading', target: files.length ? filesTarget(files) : strip(e.summary, /^(\$|Read)\s*/) };
    case 'search':
      return { icon: '⌕', verb: 'searching', target: strip(e.summary, /^(\$|Grep|Glob|WebSearch|WebFetch|web)\s*/) };
    case 'bash':
      return { icon: '▶', verb: 'running', target: strip(e.summary, /^\$\s*/) };
    case 'thinking':
      return { icon: '…', verb: 'thinking', target: '' };
    case 'message':
      return { icon: '❝', verb: 'says', target: e.summary };
    case 'user':
      return { icon: '▸', verb: 'prompt', target: e.summary };
    default:
      return { icon: '⚙', verb: 'calling', target: e.tool ?? e.summary };
  }
}

export const actionText = (e: RaceEvent) => {
  const a = describe(e);
  return `${a.icon} ${a.verb}${a.target ? ` ${a.target}` : ''}`;
};
