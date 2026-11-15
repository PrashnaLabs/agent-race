#!/usr/bin/env node
// agent-race view [race.json] [--claude f] [--codex f] [--cwd dir] [--port n] [--out f] [--no-open]
import { parseArgs } from 'node:util';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaude } from './adapters/claude.ts';
import { parseCodex } from './adapters/codex.ts';
import { agentsIn, buildRace, firstLine, type Agent, type Race } from './race.ts';

// A bare `--claude` / `--codex` (no file after it) means "pick that agent's session from a list".
const argv = process.argv.slice(2).map((a, i, all) =>
  (a === '--claude' || a === '--codex') && (i === all.length - 1 || all[i + 1].startsWith('-')) ? `${a}=` : a,
);

const { values: args, positionals } = parseArgs({
  args: argv,
  allowPositionals: true,
  options: {
    claude: { type: 'string' },
    codex: { type: 'string' },
    cwd: { type: 'string' },
    port: { type: 'string', default: '4173' },
    out: { type: 'string' },
    'no-open': { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
});

const USAGE = `agent-race view [race.json] [--claude <file>] [--codex <file>] [--cwd <dir>] [--port 4173] [--out race.json] [--no-open]

Pass one of --claude/--codex for a solo replay, or both for a race. Leave out <file> to pick from a list.
Without either, lists recent sessions from ~/.claude/projects and ~/.codex/sessions to pick from (0 skips an agent).
--cwd keeps only sessions run inside that directory.`;

if (args.help || positionals[0] !== 'view') {
  console.log(USAGE);
  process.exit(args.help ? 0 : 1);
}

const DIST = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const ROOTS: Record<Agent, string> = {
  claude: join(homedir(), '.claude/projects'),
  codex: join(homedir(), '.codex/sessions'),
};

type Session = { file: string; mtime: number; cwd: string; prompt: string };

async function jsonlFiles(dir: string, depth: number): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const d of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, d.name);
    if (d.isDirectory() && depth > 0) out.push(...(await jsonlFiles(p, depth - 1)));
    else if (d.isFile() && d.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// Session headers are near the top; avoid reading 50MB logs just to list them.
async function head(file: string, bytes = 256 * 1024): Promise<any[]> {
  const fh = await open(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    const lines = buf.subarray(0, bytesRead).toString('utf8').split('\n');
    if (bytesRead === bytes) lines.pop();
    return lines.flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  } finally {
    await fh.close();
  }
}

const promptOf = (agent: Agent, rows: any[]): string => {
  for (const o of rows) {
    let t = '';
    if (agent === 'claude' && o.type === 'user' && !o.isMeta) {
      const c = o.message?.content;
      t = typeof c === 'string' ? c : Array.isArray(c) ? (c.find((b: any) => b?.type === 'text')?.text ?? '') : '';
    } else if (agent === 'codex' && o.type === 'event_msg' && o.payload?.type === 'user_message') {
      t = o.payload.message ?? '';
    } else if (agent === 'codex' && o.payload?.item?.type === 'UserMessage') {
      t = o.payload.item.content?.[0]?.text ?? '';
    }
    if (t.trim() && !t.trim().startsWith('<')) return firstLine(t, 60);
  }
  return '';
};

async function recent(agent: Agent, cwdFilter?: string, n = 10): Promise<Session[]> {
  // Claude: projects/<dir>/<id>.jsonl only (deeper files are subagents). Codex: sessions/YYYY/MM/DD/*.jsonl.
  const files = await jsonlFiles(ROOTS[agent], agent === 'claude' ? 1 : 3);
  const withTime = await Promise.all(files.map(async (file) => ({ file, mtime: (await stat(file)).mtimeMs })));
  withTime.sort((a, b) => b.mtime - a.mtime);
  const out: Session[] = [];
  for (const f of withTime) {
    const rows = await head(f.file);
    const cwd = rows.find((o) => o.cwd)?.cwd ?? rows.find((o) => o.type === 'session_meta')?.payload?.cwd ?? '';
    if (cwdFilter && !cwd.startsWith(cwdFilter)) continue;
    out.push({ ...f, cwd, prompt: promptOf(agent, rows) });
    if (out.length >= n) break;
  }
  return out;
}

// Returns undefined when the user skips this agent (or it has no sessions).
async function pick(agent: Agent, rl: ReturnType<typeof createInterface>, canSkip: boolean): Promise<string | undefined> {
  const list = await recent(agent, args.cwd && resolve(args.cwd));
  if (!list.length) {
    console.log(`\nNo ${agent} sessions found in ${ROOTS[agent]}${args.cwd ? ` under ${args.cwd}` : ''}. Skipping.`);
    return undefined;
  }
  console.log(`\n${agent.toUpperCase()} sessions`);
  list.forEach((s, i) => {
    const when = new Date(s.mtime).toISOString().slice(0, 16).replace('T', ' ');
    const where = s.cwd.replace(homedir(), '~');
    console.log(`  ${String(i + 1).padStart(2)}) ${when}  ${where}  ${s.prompt ? `"${s.prompt}"` : ''}`);
  });
  if (canSkip) console.log(`   0) skip ${agent}`);
  const ans = (await rl.question(`Pick ${agent} session [1]: `)).trim() || '1';
  if (ans === '0' && canSkip) return undefined;
  const s = list[Number(ans) - 1];
  if (!s) throw new Error(`Invalid choice: ${ans}`);
  return s.file;
}

const PARSERS = { claude: parseClaude, codex: parseCodex };

async function loadRace(): Promise<Race> {
  if (positionals[1]?.endsWith('.json')) return JSON.parse(await readFile(positionals[1], 'utf8'));
  // --claude <file> uses that file; bare --claude ('') picks from a list; absent = not in this race.
  // No agent flags at all: pick both, either can be skipped.
  const files: Partial<Record<Agent, string>> = { claude: args.claude, codex: args.codex };
  const pickAll = files.claude === undefined && files.codex === undefined;
  const toPick = (['claude', 'codex'] as const).filter((a) => pickAll || files[a] === '');
  if (toPick.length) {
    if (!process.stdin.isTTY) throw new Error('Pass --claude <file> and/or --codex <file> when not running in a terminal.');
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      for (const a of toPick) {
        // Skipping only makes sense in pick-all mode, and the last agent can't be skipped if nothing was chosen.
        const canSkip = pickAll && (a === 'claude' || !!files.claude);
        files[a] = await pick(a, rl, canSkip);
      }
    } finally {
      rl.close();
    }
  }
  if (!files.claude && !files.codex) throw new Error('No sessions selected.');
  const sides: Parameters<typeof buildRace>[0] = {};
  for (const a of ['claude', 'codex'] as const) {
    const file = files[a];
    if (file) sides[a] = { file, parsed: PARSERS[a](await readFile(file, 'utf8')) };
  }
  return buildRace(sides);
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
};

function serve(race: Race, port: number): Promise<string> {
  const body = JSON.stringify(race);
  const server = createServer(async (req, res) => {
    const path = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    if (path === '/race.json') {
      res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
      return res.end(body);
    }
    let file = normalize(join(DIST, path === '/' ? 'index.html' : path));
    if (!file.startsWith(DIST) || !existsSync(file) || !(await stat(file)).isFile()) file = join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(await readFile(file));
  });
  // Session logs can hold secrets: loopback only.
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, '127.0.0.1', () => ok(`http://127.0.0.1:${port}`));
  });
}

try {
  const race = await loadRace();
  for (const a of agentsIn(race)) {
    const m = race.agents[a]!;
    const mins = (m.totalMs / 60_000).toFixed(1);
    console.log(`${a.padEnd(6)} ${String(m.steps).padStart(5)} events  ${mins.padStart(6)} min  ${m.totalTokens} out-tokens${m.skipped ? `  (skipped ${m.skipped} bad lines)` : ''}`);
  }
  if (args.out) {
    await writeFile(args.out, JSON.stringify(race, null, 2));
    console.log(`wrote ${args.out}`);
  }
  if (!existsSync(join(DIST, 'index.html'))) throw new Error('Viewer not built. Run `pnpm build` first.');
  const url = await serve(race, Number(args.port));
  console.log(`\nviewer: ${url}  (Ctrl+C to stop)`);
  if (!args['no-open']) spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true }).unref();
} catch (e) {
  console.error(`error: ${(e as Error).message}`);
  process.exit(1);
}
