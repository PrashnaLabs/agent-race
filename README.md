# Agent Race

Replay a Claude Code or Codex session on a 3D map of the repo, or put one of each side by side as a race.

The repo is drawn as a city: every file the agents touched is a tile, grouped into folder districts. Tiles rise as they are read and edited, colored by who touched them. Each agent is a glowing light that hops from file to file, leaving a trail. Under the map, a timeline shows every step (thinking, messages, reads, searches, edits, shell commands, tool calls) and expands into full swimlanes.

## Requirements

- Node.js 23.6 or newer (the CLI runs TypeScript directly via Node's built-in type stripping)
- pnpm
- At least one session log:
  - Claude Code: `~/.claude/projects/<project>/<session>.jsonl`
  - Codex: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`

## Setup

```sh
git clone https://github.com/PrashnaLabs/agent-race.git
cd agent-race
pnpm install
pnpm build      # builds the 3D viewer into dist/
```

## Run

```sh
pnpm race
```

This lists your 10 most recent sessions for each agent. Pick one by number (Enter picks the newest) or `0` to skip that agent:

- pick one Claude **and** one Codex session for a head-to-head race
- skip either one for a solo replay of a single session

If an agent has no sessions on this machine it is skipped automatically. The CLI parses the log(s), prints a summary, starts a local server and opens the viewer in your browser:

```
claude    53 events     2.8 min  9294 out-tokens
codex    320 events    66.4 min  24137 out-tokens

viewer: http://127.0.0.1:4173  (Ctrl+C to stop)
```

### Options

Arguments after `pnpm race` are passed to the CLI:

| Flag | What it does |
| --- | --- |
| `--cwd <dir>` | Only list sessions that ran inside this directory |
| `--claude [file]` | Include a Claude Code session. With a file, use it; without one, pick from a list |
| `--codex [file]` | Include a Codex session. With a file, use it; without one, pick from a list |
| `--out <file>` | Also save the race data as JSON |
| `--port <n>` | Server port (default `4173`) |
| `--no-open` | Don't open the browser |
| `-h, --help` | Show usage |

Examples:

Pass only `--claude` or only `--codex` for a solo replay; pass both for a race.

```sh
# Pick one Claude Code session from a list and replay it solo
pnpm race --claude

# Same for Codex
pnpm race --codex

# Compare the latest sessions run in one repo
pnpm race --cwd ~/code/my-app

# Solo replay of one session
pnpm race --claude ~/.claude/projects/-Users-me-code-my-app/abc123.jsonl
pnpm race --codex ~/.codex/sessions/2026/11/14/rollout-2026-11-14T10-00-00-xyz.jsonl

# Race two specific sessions
pnpm race --claude ~/.claude/projects/-Users-me-code-my-app/abc123.jsonl \
          --codex ~/.codex/sessions/2026/11/14/rollout-2026-11-14T10-00-00-xyz.jsonl

# Save a race, then replay it later without the original logs
pnpm race --out race.json --no-open
pnpm race race.json
```

When stdin is not a terminal (CI, scripts), pass `--claude <file>` and/or `--codex <file>`.

## Using the viewer

| Control | Action |
| --- | --- |
| `Space` | Play / pause |
| `←` / `→` | Seek back / forward |
| `1` `2` `3` `4` | Camera: **Overview** (drag to orbit, scroll to zoom), **Follow** (tracks the agents), **Top** (straight down), **Director** (cuts to the action automatically) |
| `L` | Expand / collapse the timeline into full swimlanes |
| Timeline grip (top edge) | Drag to resize the timeline (or focus it and use ↑/↓; double-click toggles). Taller than ~320px it becomes full swimlanes. The height is remembered in this browser |
| `Esc` | Close the detail panel |
| Hover a tile | File path, plus touches, tokens and time so far, per agent |
| Click a tile | Totals, then every read/edit of that file in order with its token and time share; click one to jump there |
| Height switch | Tile height shows **touches**, **lines** changed, **tokens** or **time** (timeline header) |
| Click a timeline bar (swimlanes) | Full event details: arguments, output, tokens, duration, files, plus "Jump playhead here" |
| Timeline strip | Click or drag to scrub. In swimlanes: scroll to zoom, drag to pan, double-click to reset |
| Event-type chips | Show or hide an event type in the timeline |
| Edits only | Hide files that were only read or searched, leaving just the files that changed |
| `E` / `X` / `T` (or the jump buttons) | Jump to the next edit / failed call / test-lint-typecheck run and open it. Add `Shift` to go back |
| `C` | Jump to the next chapter (a prompt you typed or a git commit). `Shift+C` goes back |
| Chapter flags (row above the lanes) | Hover for the full prompt / commit message, click to jump there |
| `R` / Report button | Session report card: time, steps, files touched/edited, lines added/removed, test runs, failures, tokens, side by side. Opens by itself the first time playback reaches the end. "Copy as Markdown" puts the table on your clipboard |
| Activity feed (under each scoreboard) | The agent's last few actions, newest first; click one to jump there and open it |
| Skip idle | Squeeze stretches where nobody did anything (over 45 s) into a short hatched band, on screen and during playback |

Speed buttons go from 1× to 1000×. The default replays the session in about 45 seconds.

Open a specific moment with a URL hash, for example `http://127.0.0.1:4173/#t=900000&cam=follow&lanes=1&h=tokens` (`t` is in milliseconds). The hash is read on page load.

### Director camera

Press `4` (or **Director**) and the camera picks shots by itself, with a caption saying what it's showing:

- **Close-up** on the file of the most important thing happening: an edit or a failed call first, then a test run, then a read or search. It orbits slowly.
- **Two-shot** framing both agents when they're doing equally important work in different parts of the repo.
- **Wide** on the whole codebase while nobody is touching files (thinking, messages).

Shots hold for about 2.5 s so the camera doesn't jitter; a new edit or failure can cut in after 0.8 s. Good for demos and screen recordings.

### How to read it

- **Edited vs read**: edited files stand tall in full color, and a ring ripples out across the map at the moment of each edit (red for a failed call). Edited files glow right after activity and cool down over time, so where the work is happening now stands out.
- **Lines changed**: every edit carries lines added/removed (Claude's Edit/MultiEdit/Write, Codex's apply_patch), shown as `+12 −3` on file labels, in the scoreboards, tooltips and file panel. Clicking an edit shows the diff in red/green. Write counts the whole file as added, since the old content isn't in the log.
- **Chapters**: every prompt you typed (yellow ▸) and every successful `git commit` (green ◆, with its message from `-m` or a heredoc) gets a flag above the timeline lanes, and a banner shows on the map for a few seconds as the playhead passes it. Messages that tools inject as user turns (e.g. agent-status notifications) count as prompts too.
- **Tests**: test, typecheck and lint runs (pytest, vitest, jest, tsc, eslint, `pnpm test`…) get ✓ / ✗ markers on the timeline. Files that were only read or searched stay as low, grey-tinted slabs. Filenames are always shown for the most-edited files and for whatever each agent is touching right now (highlighted).
- **What the agent is doing**: the label above each agent reads like `✎ editing app.ts`, `◉ reading todo.js`, `⌕ searching …`, `▶ running pnpm test`, `… thinking`, colored by action type (red on failure). A beam connects the agent to the file it is acting on: thick and glowing for an edit, thin for a read or search.
- **Tiles**: orange = Claude Code, blue = Codex. Dark grey-blue = not touched yet at the playhead. A tile flashes when it is touched, and turns whitish when hovered or selected. (Darker side faces and the glow near the agent lights are just lighting.)
- **Shared files stack**: a file touched by both agents becomes a stack of layers in time order, bottom = first. Each layer is one uninterrupted stretch of work by one agent, as thick as that stretch's share of the height metric (touches, tokens or time). So `codex / claude / codex` from the bottom means Codex worked on it, then Claude, then Codex again.
- **Tile height** (switch in the timeline header), scaled against the busiest file and growing as the replay plays:
  - **touches**: reads + 3 × edits.
  - **lines**: lines added + removed (edits split their lines evenly across the files they touched).
  - **tokens**: estimated output tokens spent on the file. Logs record tokens per model response, not per file, so each response's output tokens are split evenly across the files its tool calls touched. Responses that touched no files (planning, final answers) aren't counted, which is usually 25–30% of the total. Input tokens (file contents read into context) aren't counted.
  - **time**: how long tool calls on the file ran (call to result). A call touching several files splits its time evenly. Model thinking time isn't included.
- **Map size** follows the number of files: a session that touched a handful of files gets a small map of tall columns, a big one fills the full map.
- **Folders**: districts group files up to two folders deep. `(root)` holds top-level files; `(outside)` holds files outside the repo.
- **Scoreboards** (left edge for the first agent, right edge for the second): elapsed time, steps, files touched and output tokens so far.
- **Timeline colors**: user (yellow), thinking (violet), message (white), read (blue), search (cyan), edit (green), bash (orange), other tools (pink). Failed calls are red.
- Time spent waiting for you to type is cut to 2 seconds, and any other gap (sleep, usage-limit waits) is capped at 10 minutes.
- Tool bars are as long as the call took. Thinking, message and user bars are instants, drawn at most 15 seconds long.
- Tokens are output tokens only, counted the same way for both agents.
- Shell commands from both agents use the same classifier (`cat`/`sed`/`ls` = read, `rg`/`grep`/`find` = search, everything else = bash).
- Codex stores its reasoning encrypted, so Codex thinking events have no detail text.

**How files are found.** File paths are pulled from tool calls: Read/Edit/Write paths and `apply_patch` headers directly, and path-looking words in shell commands (with a known file extension). Claude Code's `cd` carries over between commands until a command leaves the project; Codex's `workdir` applies per command. Shell variables like `$DIR/file.txt` are skipped. This is a heuristic, so expect a few stray or missing files.

## Development

```sh
pnpm race --no-open   # terminal 1: serves race.json on :4173
pnpm dev              # terminal 2: Vite dev server with hot reload, proxies /race.json to :4173
pnpm test             # adapter, file-tracking, axis and treemap tests
pnpm typecheck
```

### Layout

```
src/
  race.ts              shared types (Race, RaceEvent) and normalization
  files.ts             which files each event touched (feeds the code map)
  adapters/claude.ts   Claude Code JSONL -> events
  adapters/codex.ts    Codex JSONL -> events
  cli.ts               session picker + local server
viewer/
  codemap.ts           folder/file treemap layout and per-file touch history
  axis.ts              real time <-> on-screen time, with idle stretches squeezed
  Scene.tsx            3D code map (React Three Fiber)
  Timeline.tsx         timeline strip / swimlanes (canvas)
  Hud.tsx              scoreboards, controls, detail panels
  store.ts             playback state (zustand)
demos/                 the three prototypes compared before picking the code map
```

A race holds one or two agents (`Race.agents` is a partial record). To support another agent, write an adapter that returns `Parsed` (see `src/race.ts`) and add it to `buildRace`.

## Privacy

Session logs can contain code, file contents and secrets. The viewer server binds to `127.0.0.1` only and nothing is uploaded anywhere. Be careful sharing a file saved with `--out`, since it includes tool arguments and outputs (truncated to 4 KB each).

## Roadmap

- Race runner: start both agents on the same task in separate git worktrees, so races are head-to-head on identical work
- Cost in dollars alongside tokens in the report card
- Share exporter (PNG, GIF, standalone HTML)
- More agents (adapters are small: see `src/adapters/`)

## Contributing

Issues and PRs are welcome. Before opening a PR, run:

```sh
pnpm test && pnpm typecheck && pnpm build
```

Please don't attach real session logs to issues: they can contain code, prompts and secrets. A minimal hand-written JSONL snippet (like the fixtures in `src/adapters.test.ts`) is enough to reproduce parsing bugs.

## License

[MIT](LICENSE) © Prashna Labs
