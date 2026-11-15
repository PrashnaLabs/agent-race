// Which files an event touched, relative to the session's cwd. Feeds the code map.
// No node imports: the browser viewer imports this module too.
import type { Kind, RawEvent } from './race.ts';

// ponytail: path-looking tokens with a known extension; misses extensionless files (Makefile, Dockerfile).
const PATH =
  /(?:~|\.{0,2})?\/?(?:[\w@.+-]+\/)*[\w@+-][\w@.+-]*\.(?:tsx?|jsx?|mjs|cjs|py|md|mdx|json|jsonl|css|scss|html|go|rs|toml|ya?ml|sh|sql|txt|env|lock|svg|png|ipynb|cfg|ini|java|kt|rb|php|swift|c|h|cpp|vue|svelte|astro)\b/g;
const FILE_KINDS: Kind[] = ['read', 'edit', 'search', 'bash'];
const MAX_FILES = 6;
const OUTSIDE = Symbol('outside');

// posix-style join + normalize without node:path. undefined when `..` climbs out of the repo.
const join = (dir: string, p: string): string | undefined => {
  const path = decodeURIComponent(new URL(p, `file:///r/${dir ? `${dir}/` : ''}`).pathname);
  return path.startsWith('/r/') || path === '/r' ? path.slice(3) : undefined;
};

// The shell command string inside the tool input JSON (Claude: "command", Codex: "cmd").
export function commandOf(input: string): string {
  const m = input.match(/"?(?:command|cmd)"?\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
  if (m == null) return '';
  try {
    return JSON.parse(`"${m}"`);
  } catch {
    return m;
  }
}

/**
 * Returns a function that maps events, in order, to touched files.
 * persistentCd mirrors Claude Code's Bash: `cd` carries over to later commands, but the shell is reset
 * to the project root when a command leaves the project. Codex runs every command fresh (`workdir`).
 */
export function fileTracker(cwd: string, persistentCd = false) {
  let shellDir = '';
  const resolveDir = (from: string, target: string): string | typeof OUTSIDE => {
    const t = target.trim().replace(/^["']|["']$/g, '');
    if (!t || t.includes('$') || t.startsWith('~') || t === '-') return OUTSIDE;
    if (t.startsWith('/')) return cwd && (t === cwd || t.startsWith(`${cwd}/`)) ? t.slice(cwd.length + 1) : OUTSIDE;
    return join(from, t) ?? OUTSIDE;
  };

  return (e: Pick<RawEvent, 'kind' | 'summary' | 'detail'>): string[] => {
    if (!FILE_KINDS.includes(e.kind)) return [];
    const input = (e.detail ?? '').split('── output ──')[0].slice(0, 800);
    let dir = '';
    if (e.summary.startsWith('$ ')) {
      const start = persistentCd ? shellDir : '';
      const workdir = input.match(/"workdir"\s*:\s*"([^"]+)"/)?.[1];
      const cds = commandOf(input)
        .split(/&&|\|\||;|\n/)
        .map((s, i) => ({ t: s.trim().match(/^cd\s+(.+)$/)?.[1], i }))
        .filter((x): x is { t: string; i: number } => x.t != null);
      let cur: string | typeof OUTSIDE = workdir ? resolveDir('', workdir) : start;
      let leading: string | typeof OUTSIDE = cur;
      for (const { t, i } of cds) {
        cur = cur === OUTSIDE ? resolveDir('', t) : resolveDir(cur, t);
        if (i === 0) leading = cur; // `cd x && ...`: paths in this command are relative to x
      }
      dir = leading === OUTSIDE ? '' : leading;
      if (persistentCd) shellDir = cur === OUTSIDE ? '' : cur; // left the project -> reset to root
    }
    const text = `${e.summary}\n${input}`;
    const out = new Set<string>();
    for (const m of text.matchAll(PATH)) {
      let p = m[0];
      const before = text[m.index - 1] ?? '';
      if (before === '$' || before === '}' || before === '{') continue; // $VAR/x, ${VAR}/x: can't resolve
      if (cwd && p.startsWith(`${cwd}/`)) p = p.slice(cwd.length + 1);
      else if (p.startsWith('/') || p.startsWith('~')) p = `(outside)/${p.split('/').pop()}`;
      // git rev:path, or a path already spelled from the root (`git add sub/x` while in sub), is root-relative
      else if (before === ':' || (dir && p.startsWith(`${dir}/`))) p = join('', p) ?? `(outside)/${p.split('/').pop()}`;
      else p = join(dir, p) ?? `(outside)/${p.split('/').pop()}`;
      if (!p || /^\d+(\.\d+)+$/.test(p) || p.includes('node_modules/')) continue; // versions, deps
      out.add(p);
      if (out.size >= MAX_FILES) break;
    }
    return [...out];
  };
}
