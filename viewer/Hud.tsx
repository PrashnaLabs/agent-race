import type { CSSProperties } from 'react';
import { KINDS, type Agent } from '../src/race.ts';
import type { FileNode, Metric } from './codemap.ts';
import { Timeline } from './Timeline.tsx';
import {
  AGENT_COLOR,
  AGENT_NAME,
  BOTH_COLOR,
  FAIL_COLOR,
  KIND_COLOR,
  SPEEDS,
  evColor,
  fmtDur,
  fmtMs,
  fmtTok,
  idxAt,
  setCollapse,
  togglePlay,
  useRace,
  type Cam,
} from './store.ts';

// Per-agent totals for a file, optionally only touches up to `time`.
function fileStats(f: FileNode, agent: Agent, time = Infinity) {
  let n = 0;
  let tokens = 0;
  let ms = 0;
  for (const x of f.touches)
    if (x.agent === agent && x.t <= time) {
      n++;
      tokens += x.tokens;
      ms += x.ms;
    }
  return { n, tokens, ms };
}
const statLine = (s: ReturnType<typeof fileStats>) => `${s.n} touches · ${fmtTok(s.tokens)} tok · ${fmtDur(s.ms)}`;

function AgentCard({ agent }: { agent: Agent }) {
  const meta = useRace((s) => s.meta[agent]);
  const lane = useRace((s) => s.lanes[agent]);
  const time = useRace((s) => s.time);
  const other = useRace((s) => s.agents.filter((a) => a !== agent).map((a) => s.meta[a])[0]);
  const files = useRace((s) => s.map.files);
  const i = idxAt(lane.events, time);
  const done = time >= meta.totalMs;
  const won = done && !!other && meta.totalMs <= other.totalMs; // no winner in a solo replay
  const touched = files.filter((f) => (f.first[agent] ?? Infinity) <= time).length;
  const pct = meta.steps ? ((i + 1) / meta.steps) * 100 : 0;
  return (
    <section className="card" style={{ '--c': AGENT_COLOR[agent] } as CSSProperties}>
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
          <b>{(lane.cumTokens[i] ?? 0).toLocaleString()}</b>
          <small>out tokens</small>
        </div>
      </div>
      <div className="bar">
        <i style={{ transform: `scaleX(${pct / 100})` }} />
      </div>
    </section>
  );
}

function TimelinePanel() {
  const hidden = useRace((s) => s.hidden);
  const open = useRace((s) => s.lanesOpen);
  const agents = useRace((s) => s.agents);
  const metric = useRace((s) => s.metric);
  const set = useRace((s) => s.set);
  return (
    <section className={open ? 'tlpanel open' : 'tlpanel'} aria-label="Timeline">
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
          {agents.length > 1 && (
            <span>
              <i style={{ background: BOTH_COLOR }} />
              both
            </span>
          )}
        </p>
        <Segmented<Metric>
          label="Tile height"
          value={metric}
          options={[['touches', 'Height: touches'], ['tokens', 'tokens'], ['time', 'time']]}
          onChange={(metric) => set({ metric })}
        />
        <button className="expand" aria-pressed={open} onClick={() => set({ lanesOpen: !open })}>
          {open ? 'Collapse timeline' : 'Expand to swimlanes'}
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
      <Segmented<Cam> label="Camera" value={cam} options={[['overview', 'Overview'], ['follow', 'Follow'], ['top', 'Top']]} onChange={(cam) => set({ cam })} />
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
      {e.detail && <pre>{e.detail}</pre>}
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
                {fmtTok(x.tokens)} · {fmtDur(x.ms)}
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

export function Hud() {
  const agents = useRace((s) => s.agents);
  return (
    <>
      <div className="top">
        {agents.map((a) => (
          <AgentCard key={a} agent={a} />
        ))}
      </div>
      <EventDetail />
      <FileDetail />
      <TimelinePanel />
      <Tooltip />
      <Controls />
      <p className="keys">space play · ←/→ seek · 1 2 3 camera · L swimlanes · esc close</p>
    </>
  );
}
