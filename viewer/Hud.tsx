import { useEffect, useRef, type CSSProperties } from 'react';
import { KINDS, type Agent, type RaceEvent } from '../src/race.ts';
import type { FileNode, Metric } from './codemap.ts';
import { Timeline } from './Timeline.tsx';
import { describe } from './actions.ts';
import { isCheck, isEdit, isError, stats, type Stats } from './report.ts';
import {
  AGENT_COLOR,
  AGENT_NAME,
  FAIL_COLOR,
  KIND_COLOR,
  SPEEDS,
  evColor,
  fmtDur,
  fmtMs,
  fmtTok,
  idxAt,
  TL_MIN,
  isFull,
  setCollapse,
  setTlH,
  tlMax,
  jumpTo,
  toggleLanes,
  togglePlay,
  useRace,
  type Cam,
} from './store.ts';

// Per-agent totals for a file, optionally only touches up to `time`.
function fileStats(f: FileNode, agent: Agent, time = Infinity) {
  let n = 0;
  let tokens = 0;
  let ms = 0;
  let added = 0;
  let removed = 0;
  for (const x of f.touches)
    if (x.agent === agent && x.t <= time) {
      n++;
      tokens += x.tokens;
      ms += x.ms;
      added += x.added;
      removed += x.removed;
    }
  return { n, tokens, ms, added, removed };
}
const lines = (a: number, r: number) => `+${Math.round(a)} −${Math.round(r)}`;
const statLine = (s: ReturnType<typeof fileStats>) =>
  `${s.n} touches${s.added || s.removed ? ` · ${lines(s.added, s.removed)}` : ''} · ${fmtTok(s.tokens)} tok · ${fmtDur(s.ms)}`;

function AgentCard({ agent, side }: { agent: Agent; side: 'left' | 'right' }) {
  const meta = useRace((s) => s.meta[agent]);
  const lane = useRace((s) => s.lanes[agent]);
  const time = useRace((s) => s.time);
  const other = useRace((s) => s.agents.filter((a) => a !== agent).map((a) => s.meta[a])[0]);
  const files = useRace((s) => s.map.files);
  const i = idxAt(lane.events, time);
  const done = time >= meta.totalMs;
  const won = done && !!other && meta.totalMs <= other.totalMs; // no winner in a solo replay
  const touched = files.filter((f) => (f.first[agent] ?? Infinity) <= time).length;
  const linesSoFar = { a: 0, r: 0 };
  for (let j = 0; j <= i; j++) {
    linesSoFar.a += lane.events[j].added ?? 0;
    linesSoFar.r += lane.events[j].removed ?? 0;
  }
  const pct = meta.steps ? ((i + 1) / meta.steps) * 100 : 0;
  const set = useRace((s) => s.set);
  // Recent actions, newest first. Thinking is skipped unless it's what's happening right now.
  const feed: RaceEvent[] = [];
  for (let j = i; j >= 0 && feed.length < 6; j--) if (j === i || lane.events[j].kind !== 'thinking') feed.push(lane.events[j]);
  return (
    <section className={`card ${side}`} style={{ '--c': AGENT_COLOR[agent] } as CSSProperties} aria-label={`${AGENT_NAME[agent]} progress`}>
      <header>
        <span className="name">{AGENT_NAME[agent]}</span>
        {meta.model && <span className="model">{meta.model}</span>}
        {done && <span className={won ? 'badge win' : 'badge'}>{won ? 'Finished first' : 'Finished'}</span>}
      </header>
      <div className="stats">
        <div>
          <b>{fmtMs(Math.min(time, meta.totalMs))}</b>
          <small>of {fmtMs(meta.totalMs)}</small>
        </div>
        <div>
          <b>{i + 1}</b>
          <small>of {meta.steps} steps</small>
        </div>
        <div>
          <b>{touched}</b>
          <small>files</small>
        </div>
        <div>
          <b className="lines">{lines(linesSoFar.a, linesSoFar.r)}</b>
          <small>lines</small>
        </div>
        <div>
          <b>{(lane.cumTokens[i] ?? 0).toLocaleString()}</b>
          <small>out tokens</small>
        </div>
      </div>
      <div className="bar">
        <i style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
      {feed.length > 0 && (
        <ol className="feed" aria-label={`${AGENT_NAME[agent]} recent actions`}>
          {feed.map((e, k) => {
            const a = describe(e);
            return (
              <li key={e.id} className={k === 0 && !done ? 'now' : undefined}>
                <button
                  style={{ '--k': evColor(e) } as CSSProperties}
                  title={`${fmtMs(e.t)} · ${e.summary}`}
                  onClick={() => set({ time: e.t, playing: false, selected: e, selFile: null })}
                >
                  <span className="ic">{a.icon}</span>
                  <span className="tx">
                    <b>{a.verb}</b> {a.target}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

function TimelinePanel() {
  const hidden = useRace((s) => s.hidden);
  const tlH = useRace((s) => s.tlH);
  const open = isFull(tlH);
  const agents = useRace((s) => s.agents);
  const metric = useRace((s) => s.metric);
  const editsOnly = useRace((s) => s.editsOnly);
  const set = useRace((s) => s.set);
  const drag = useRef<{ y: number; h: number } | null>(null);

  // The map, detail panel and timeline all size off --tl-h.
  useEffect(() => document.documentElement.style.setProperty('--tl-h', `${tlH}px`), [tlH]);
  useEffect(() => {
    const onResize = () => setTlH(useRace.getState().tlH); // re-clamp to the new window height
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, []);

  return (
    <section className="tlpanel" aria-label="Timeline">
      <div
        className="grip"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize timeline (drag, arrow keys, or double-click)"
        aria-valuenow={tlH}
        aria-valuemin={TL_MIN}
        aria-valuemax={tlMax()}
        tabIndex={0}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          drag.current = { y: e.clientY, h: tlH };
        }}
        onPointerMove={(e) => drag.current && setTlH(drag.current.h + drag.current.y - e.clientY)}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={toggleLanes}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          setTlH(tlH + (e.key === 'ArrowUp' ? 40 : -40));
        }}
      />
      <header>
        <nav className="filters" aria-label="Event types">
          {KINDS.map((k) => {
            const on = !hidden.includes(k);
            return (
              <button
                key={k}
                aria-pressed={on}
                className={on ? 'chip' : 'chip off'}
                onClick={() => set({ hidden: on ? [...hidden, k] : hidden.filter((h) => h !== k) })}
              >
                <i style={{ background: KIND_COLOR[k] }} />
                {k}
              </button>
            );
          })}
          <span className="chip static">
            <i style={{ background: FAIL_COLOR }} />
            failed
          </span>
        </nav>
        <p className="mapkey">
          Tiles:{' '}
          {agents.map((a) => (
            <span key={a}>
              <i style={{ background: AGENT_COLOR[a] }} />
              {AGENT_NAME[a]}
            </span>
          ))}
          <span className="muted" title="Edited files stand tall in full color and ripple when edited; files only read or searched stay low and grey. Files both agents touched stack in time order, bottom = first.">
            tall = edited · grey = read
          </span>
        </p>
        <label className="toggle">
          <input type="checkbox" checked={editsOnly} onChange={(e) => set({ editsOnly: e.target.checked })} />
          Edits only
        </label>
        <Segmented<Metric>
          label="Tile height"
          value={metric}
          options={[['touches', 'Height: touches'], ['lines', 'lines'], ['tokens', 'tokens'], ['time', 'time']]}
          onChange={(metric) => set({ metric })}
        />
        <button className="expand" aria-pressed={open} onClick={toggleLanes}>
          {open ? 'Collapse swimlanes' : 'Expand swimlanes'}
        </button>
      </header>
      <Timeline />
    </section>
  );
}

function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

function Controls() {
  const { time, maxMs, playing, speed, cam, collapse, axis, set } = useRace();
  return (
    <footer className="controls">
      <button className="play" aria-label={playing ? 'Pause' : 'Play'} onClick={togglePlay}>
        {playing ? '❚❚' : '▶'}
      </button>
      <span className="clock">
        {fmtMs(time)} <small>/ {fmtMs(maxMs)}</small>
      </span>
      <input
        type="range"
        aria-label="Scrub timeline"
        min={0}
        max={axis.total}
        step="any"
        value={axis.toV(time)}
        onChange={(e) => set({ time: axis.toT(Number(e.target.value)) })}
      />
      <Segmented label="Speed" value={String(speed)} options={SPEEDS.map((s) => [String(s), `${s}×`])} onChange={(v) => set({ speed: Number(v) })} />
      <label className="toggle">
        <input type="checkbox" checked={collapse} onChange={(e) => setCollapse(e.target.checked)} />
        Skip idle
      </label>
      <div className="seg jumps" role="group" aria-label="Jump to next">
        <button title="Next edit (E, Shift+E for previous)" onClick={() => jumpTo(isEdit, 1)}>
          ✎ next edit
        </button>
        <button title="Next failed call (X, Shift+X for previous)" onClick={() => jumpTo(isError, 1)}>
          ✗ error
        </button>
        <button title="Next test / typecheck / lint run (T, Shift+T for previous)" onClick={() => jumpTo(isCheck, 1)}>
          ✓ test
        </button>
      </div>
      <Segmented<Cam>
        label="Camera"
        value={cam}
        options={[['overview', 'Overview'], ['follow', 'Follow'], ['top', 'Top'], ['director', 'Director']]}
        onChange={(cam) => set({ cam })}
      />
      <button className="reportbtn" onClick={() => set({ report: true, reportSeen: true })}>
        Report
      </button>
    </footer>
  );
}

function EventDetail() {
  const e = useRace((s) => s.selected);
  const set = useRace((s) => s.set);
  if (!e) return null;
  const color = evColor(e);
  return (
    <aside className="detail" aria-label="Event details">
      <header>
        <span className="kind" style={{ color }}>
          {e.tool ?? e.kind}
        </span>
        <span className="who" style={{ color: AGENT_COLOR[e.agent] }}>
          {AGENT_NAME[e.agent]}
        </span>
        <button className="x" aria-label="Close" onClick={() => set({ selected: null })}>
          ×
        </button>
      </header>
      <h2>{e.summary}</h2>
      <dl>
        <dt>at</dt>
        <dd>{fmtMs(e.t)}</dd>
        <dt>took</dt>
        <dd>{fmtDur(e.dur)}</dd>
        <dt>step</dt>
        <dd>#{e.step + 1}</dd>
        <dt>tokens</dt>
        <dd>{e.tokens?.toLocaleString() ?? '—'}</dd>
        {e.ok != null && (
          <>
            <dt>result</dt>
            <dd style={{ color: e.ok ? KIND_COLOR.edit : FAIL_COLOR }}>{e.ok ? 'ok' : 'error'}</dd>
          </>
        )}
        {e.files?.length ? (
          <>
            <dt>files</dt>
            <dd>
              {e.files.map((p) => (
                <FileLink key={p} path={p} />
              ))}
            </dd>
          </>
        ) : null}
      </dl>
      <button className="jump" onClick={() => set({ time: e.t, playing: false })}>
        Jump playhead here
      </button>
      {e.diff && (
        <pre className="diff" aria-label={`Diff ${lines(e.added ?? 0, e.removed ?? 0)}`}>
          {e.diff.split('\n').map((l, k) => (
            <span key={k} className={l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : 'hunk'}>
              {l}
              {'\n'}
            </span>
          ))}
        </pre>
      )}
      {e.detail && <pre className={e.diff ? 'raw' : undefined}>{e.detail}</pre>}
    </aside>
  );
}

function FileLink({ path }: { path: string }) {
  const file = useRace((s) => s.map.byPath.get(path));
  const set = useRace((s) => s.set);
  return file ? (
    <button className="filelink" onClick={() => set({ selFile: file, selected: null })}>
      {path}
    </button>
  ) : (
    <div>{path}</div>
  );
}

function FileAgentRow({ f, agent }: { f: FileNode; agent: Agent }) {
  const s = fileStats(f, agent);
  return (
    <>
      <dt style={{ color: AGENT_COLOR[agent] }}>{AGENT_NAME[agent]}</dt>
      <dd>{s.n ? `${statLine(s)} · first at ${fmtMs(f.first[agent]!)}` : 'never touched'}</dd>
    </>
  );
}

function FileDetail() {
  const f = useRace((s) => s.selFile);
  const agents = useRace((s) => s.agents);
  const set = useRace((s) => s.set);
  if (!f) return null;
  const reads = f.touches.filter((x) => !x.edit).length;
  return (
    <aside className="detail" aria-label="File details">
      <header>
        <span className="kind">file</span>
        <button className="x" aria-label="Close" onClick={() => set({ selFile: null })}>
          ×
        </button>
      </header>
      <h2>{f.path}</h2>
      <dl>
        <dt>touches</dt>
        <dd>
          {f.touches.length} ({reads} read, {f.touches.length - reads} edit)
        </dd>
        <dt>tokens</dt>
        <dd>~{fmtTok(f.tokAt.at(-1) ?? 0)} output (est.)</dd>
        <dt>time</dt>
        <dd>{fmtDur(f.msAt.at(-1) ?? 0)} in tool calls</dd>
        <dt>lines</dt>
        <dd>{lines(f.addAt.at(-1) ?? 0, f.remAt.at(-1) ?? 0)}</dd>
        {agents.map((a) => (
          <FileAgentRow key={a} f={f} agent={a} />
        ))}
      </dl>
      <p className="note">Tokens: each model response's output tokens, split across the files its tool calls touched. Time: tool run time, split across files.</p>
      <ol className="touches">
        {f.touches.map((x) => (
          <li key={x.ev.id}>
            <button onClick={() => set({ time: x.t, playing: false, selected: x.ev, selFile: null })}>
              <i style={{ background: AGENT_COLOR[x.agent] }} />
              <span className="when">{fmtMs(x.t)}</span>
              <span className="what" style={{ color: evColor(x.ev) }}>
                {x.edit ? 'edit' : x.ev.kind}
              </span>
              <span className="sum">{x.ev.summary}</span>
              <span className="cost">
                {x.edit ? lines(x.added, x.removed) : `${fmtTok(x.tokens)} · ${fmtDur(x.ms)}`}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </aside>
  );
}

function Tooltip() {
  const hover = useRace((s) => s.hover);
  const time = useRace((s) => s.time);
  const agents = useRace((s) => s.agents);
  if (!hover) return null;
  const { ev, file, x, y } = hover;
  const style = { left: Math.min(x + 14, innerWidth - 380), top: Math.min(y + 14, innerHeight - 60) };
  if (file)
    return (
      <div className="tip" style={style}>
        <i style={{ background: '#94a3b8' }} />
        <span>{file.path}</span>
        {agents.map((a) => (
          <small key={a}>
            <b style={{ color: AGENT_COLOR[a] }}>{AGENT_NAME[a]}</b> {statLine(fileStats(file, a, time))}
          </small>
        ))}
      </div>
    );
  if (!ev) return null;
  return (
    <div className="tip" style={style}>
      <i style={{ background: evColor(ev) }} />
      <span>{ev.summary}</span>
      <small>
        {AGENT_NAME[ev.agent]} · {fmtMs(ev.t)} · {fmtDur(ev.dur)}
        {ev.tokens ? ` · ${ev.tokens} tok` : ''}
      </small>
    </div>
  );
}

// Side-by-side outcome of the session(s) at the end of playback. Lower is better for time, steps, errors, tokens.
const ROWS: { key: keyof Stats; label: string; fmt: (v: number) => string; better?: 'low' }[] = [
  { key: 'ms', label: 'Active time', fmt: fmtMs, better: 'low' },
  { key: 'steps', label: 'Steps', fmt: String, better: 'low' },
  { key: 'filesTouched', label: 'Files touched', fmt: String },
  { key: 'filesEdited', label: 'Files edited', fmt: String },
  { key: 'added', label: 'Lines added', fmt: (v) => `+${Math.round(v)}` },
  { key: 'removed', label: 'Lines removed', fmt: (v) => `−${Math.round(v)}` },
  { key: 'checks', label: 'Test / lint runs', fmt: String },
  { key: 'checksFailed', label: 'Failed test runs', fmt: String, better: 'low' },
  { key: 'errors', label: 'Failed calls', fmt: String, better: 'low' },
  { key: 'tokens', label: 'Output tokens', fmt: (v) => v.toLocaleString(), better: 'low' },
];

function Report() {
  const open = useRace((s) => s.report);
  const agents = useRace((s) => s.agents);
  const lanes = useRace((s) => s.lanes);
  const map = useRace((s) => s.map);
  const set = useRace((s) => s.set);
  if (!open) return null;
  const all = agents.map((a) => ({ a, s: stats(lanes[a].events, map, a) }));
  const best = (r: (typeof ROWS)[number]) =>
    r.better && all.length > 1 ? Math.min(...all.map((x) => x.s[r.key])) : undefined;
  const markdown = [
    `| | ${agents.map((a) => AGENT_NAME[a]).join(' | ')} |`,
    `|---|${agents.map(() => '---').join('|')}|`,
    ...ROWS.map((r) => `| ${r.label} | ${all.map((x) => r.fmt(x.s[r.key])).join(' | ')} |`),
  ].join('\n');
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-label="Session report" onClick={() => set({ report: false })}>
      <section className="report" onClick={(e) => e.stopPropagation()}>
        <header>
          <h2>Session report</h2>
          <button className="x" aria-label="Close" onClick={() => set({ report: false })}>
            ×
          </button>
        </header>
        <table>
          <thead>
            <tr>
              <th />
              {agents.map((a) => (
                <th key={a} style={{ color: AGENT_COLOR[a] }}>
                  {AGENT_NAME[a]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => {
              const b = best(r);
              return (
                <tr key={r.key}>
                  <th scope="row">{r.label}</th>
                  {all.map((x) => (
                    <td key={x.a} className={b != null && x.s[r.key] === b ? 'best' : undefined}>
                      {r.fmt(x.s[r.key])}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
        <p className="note">
          Highlighted = better (lower) where it makes sense. Tests are detected from command names (test, pytest, vitest, tsc, lint…).
        </p>
        <footer>
          <button className="jump" onClick={() => navigator.clipboard?.writeText(markdown)}>
            Copy as Markdown
          </button>
        </footer>
      </section>
    </div>
  );
}

function ShotCaption() {
  const cam = useRace((s) => s.cam);
  const shot = useRace((s) => s.shot);
  if (cam !== 'director' || !shot) return null;
  return (
    <p className="shotcap" aria-live="polite">
      <span>🎬</span> {shot}
    </p>
  );
}

export function Hud() {
  const agents = useRace((s) => s.agents);
  return (
    <>
      <div className="cards">
        {agents.map((a, i) => (
          <AgentCard key={a} agent={a} side={i ? 'right' : 'left'} />
        ))}
      </div>
      <EventDetail />
      <FileDetail />
      <TimelinePanel />
      <Tooltip />
      <Controls />
      <Report />
      <ShotCaption />
      <p className="keys">space play · ←/→ seek · 1–4 camera · E/X/T next edit/error/test · R report · L swimlanes · esc close</p>
    </>
  );
}
