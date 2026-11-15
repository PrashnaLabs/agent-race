// Builds demos/compare.html: three visualization prototypes over one embedded race.
// node demos/build.ts [--claude f] [--codex f] [--out demos/compare.html]
import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseClaude } from '../src/adapters/claude.ts';
import { parseCodex } from '../src/adapters/codex.ts';
import { buildRace } from '../src/race.ts';

const here = dirname(fileURLToPath(import.meta.url));
const { values: args } = parseArgs({
  options: { claude: { type: 'string' }, codex: { type: 'string' }, out: { type: 'string', default: join(here, 'compare.html') } },
});
if (!args.claude && !args.codex) {
  console.error('usage: node demos/build.ts [--claude <file>] [--codex <file>] [--out <file>]');
  process.exit(1);
}

const sides: Parameters<typeof buildRace>[0] = {};
if (args.claude) sides.claude = { file: args.claude, parsed: parseClaude(await readFile(args.claude, 'utf8')) };
if (args.codex) sides.codex = { file: args.codex, parsed: parseCodex(await readFile(args.codex, 'utf8')) };
const race = buildRace(sides);

const events = race.events.map((e) => ({ ...e, files: e.files ?? [], detail: e.detail?.slice(0, 600) }));
const json = JSON.stringify({ ...race, events }).replace(/</g, '\\u003c');
// Function replacer: a string replacer would expand `$'` / `$&` found in shell commands.
const html = (await readFile(join(here, 'compare.template.html'), 'utf8')).replace('/*RACE_JSON*/null', () => json);
await writeFile(args.out!, html);
console.log(`wrote ${args.out}  (${events.length} events, ${events.filter((e) => e.files.length).length} with file paths)`);
