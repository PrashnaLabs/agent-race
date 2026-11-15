import { useLayoutEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Edges, Html, OrbitControls } from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import * as THREE from 'three';
import type { Agent } from '../src/race.ts';
import { metricValue, upper, type FileNode } from './codemap.ts';
import { AGENT_COLOR, AGENT_NAME, FAIL_COLOR, KIND_COLOR, idxAt, useRace } from './store.ts';
import { actionText } from './actions.ts';
import { pickShot, priority, shotKey, type Focus, type Shot } from './director.ts';

const BG = '#07090d';
type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

// Per-frame shared state, deliberately outside React: tile heights (bots sit on them) and bot positions (follow cam).
const tileH: number[] = []; // animated total height per file (drives layer thickness)
const stackH: number[] = []; // actual top of each file's stack (layers add seams/min heights)
const botPos: Partial<Record<Agent, THREE.Vector3>> = {};

const center = (f: FileNode) => [f.rect.x + f.rect.w / 2, f.rect.y + f.rect.h / 2] as const;
// Square-root scale against the busiest file: every metric spans 0.3..6, big gaps stay visible
// (log squashed an 11k-token file and a 786-token one to similar heights).
const targetHeight = (v: number, max: number) => 0.3 + 5.7 * Math.sqrt(v / Math.max(max, 1));

// Playback advances in visual time, so squeezed idle gaps fly by.
function Driver() {
  useFrame((_, dt) => {
    const s = useRace.getState();
    if (!s.playing) return;
    const v = s.axis.toV(s.time) + dt * 1000 * s.speed;
    if (v >= s.axis.total) s.set({ time: s.maxMs, playing: false, ...(!s.reportSeen && { report: true, reportSeen: true }) });
    else s.set({ time: s.axis.toT(v) });
  }, -2);
  return null;
}

function Districts() {
  const groups = useRace((s) => s.map.groups);
  return (
    <group>
      {groups.map((g) => {
        const r = g.rect;
        const pad = 0.35;
        return (
          <group key={g.key}>
            <mesh position={[r.x + r.w / 2, 0, r.y + r.h / 2]}>
              <boxGeometry args={[Math.max(r.w - pad, 0.1), 0.08, Math.max(r.h - pad, 0.1)]} />
              <meshStandardMaterial color="#111723" roughness={0.9} />
              <Edges color="#273246" />
            </mesh>
            {r.w > 3 && r.h > 1.5 && (
              <Html position={[r.x + pad, 0.1, r.y + pad]} className="label3d dir" zIndexRange={[10, 0]}>
                {g.key}
              </Html>
            )}
          </group>
        );
      })}
    </group>
  );
}

const tmpM = new THREE.Matrix4();
const tmpP = new THREE.Vector3();
const tmpS = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();
const tmpC = new THREE.Color();
const UNTOUCHED = new THREE.Color('#1b2232');
const WHITE = new THREE.Color('#ffffff');

// One instance per run (consecutive touches by one agent). Files touched by both agents become stacks
// of layers in time order, each as thick as its share of the height metric.
const MIN_LAYER = 0.07;
const SEAM = 0.035; // dark gap between layers so the stack reads as separate changes
// Read-only files sink to low, grey-tinted slabs so edited files carry the map.
const READ_H = 0.22;
const SLATE = new THREE.Color('#3a4256');

function Tiles() {
  const files = useRace((s) => s.map.files);
  const runs = useRace((s) => s.map.runs);
  const max = useRace((s) => s.map.max);
  const agents = useRace((s) => s.agents);
  const ref = useRef<THREE.InstancedMesh>(null!);
  const colors = useMemo(() => Object.fromEntries(agents.map((a) => [a, new THREE.Color(AGENT_COLOR[a])])) as Record<string, THREE.Color>, [agents]);
  const firstRun = useMemo(() => new Set(files.map((f) => f.runs[0])), [files]);

  useLayoutEffect(() => {
    files.forEach((f) => {
      tileH[f.i] = 0.06;
      stackH[f.i] = 0.06;
    });
    runs.forEach((_, i) => ref.current.setColorAt(i, UNTOUCHED)); // allocates instanceColor
  }, [files, runs]);

  useFrame((_, dt) => {
    if (!runs.length) return;
    const { time, speed, axis, selected, selFile, hover, metric, editsOnly } = useRace.getState();
    const k = 1 - Math.exp(-dt * 8);
    const now = axis.toV(time);
    const flash = 500 * speed; // ~0.5s of real time at any speed
    let base = 0; // running bottom of the current file's stack
    let file: FileNode | null = null;
    let n = 0;
    let total = 0;
    let started = 0;
    let edited = false; // file edited by anyone so far
    let hide = false;

    runs.forEach((r, i) => {
      const f = r.file;
      if (f !== file) {
        // new file: advance its animated total height, reset the stack
        file = f;
        n = upper(f.touches, time);
        total = metricValue(f, n, metric);
        started = f.runs.filter((x) => x.start < n).length;
        edited = n > 0 && f.editsAt[n - 1] > 0;
        hide = editsOnly && !edited;
        tileH[f.i] += ((!n ? 0.06 : edited ? targetHeight(total, max[metric]) : READ_H) - tileH[f.i]) * k;
        base = 0;
      }
      const gap = Math.min(0.18, f.rect.w * 0.2, f.rect.h * 0.2);
      const [cx, cz] = center(f);
      const w = Math.max(f.rect.w - gap * 2, 0.05);
      const d = Math.max(f.rect.h - gap * 2, 0.05);

      if (hide) {
        tmpS.set(0, 0, 0);
        ref.current.setMatrixAt(i, tmpM.compose(tmpP.set(cx, 0, cz), tmpQ, tmpS));
        stackH[f.i] = 0;
        return;
      }
      if (r.start >= n) {
        // not reached yet: the bottom run doubles as the flat "untouched" tile
        const ghost = !n && firstRun.has(r);
        tmpP.set(cx, 0.03, cz);
        tmpS.set(ghost ? w : 0, ghost ? 0.06 : 0, ghost ? d : 0);
        ref.current.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
        ref.current.setColorAt(i, UNTOUCHED);
        if (ghost) stackH[f.i] = 0.06;
        return;
      }
      const upto = Math.min(r.end, n);
      const part = metricValue(f, upto, metric) - metricValue(f, r.start, metric);
      const share = total > 0 ? part / total : 1 / started;
      const h = Math.max(tileH[f.i] * share, MIN_LAYER);
      const sh = started > 1 ? Math.max(h - SEAM, MIN_LAYER * 0.6) : h;
      tmpP.set(cx, base + sh / 2, cz);
      tmpS.set(w, sh, d);
      ref.current.setMatrixAt(i, tmpM.compose(tmpP, tmpQ, tmpS));
      base += h;
      stackH[f.i] = base;

      const runEdited = f.editsAt[upto - 1] - (r.start ? f.editsAt[r.start - 1] : 0) > 0;
      const recent = now - axis.toV(f.touches[upto - 1].t) < flash;
      if (!edited) tmpC.copy(colors[r.agent]).lerp(SLATE, 0.65).multiplyScalar(recent ? 1.4 : 0.75);
      else {
        // Heat: edited files glow right after activity and cool down over ~5% of the session.
        const heat = Math.exp(-(now - axis.toV(f.touches[n - 1].t)) / Math.max(axis.total * 0.05, 15_000));
        tmpC.copy(colors[r.agent]).multiplyScalar((runEdited ? 1 : 0.55) * (0.7 + 0.7 * heat));
        if (recent) tmpC.multiplyScalar(2.6); // HDR flash -> bloom
      }
      if (f === selFile || f === hover?.file || selected?.files?.includes(f.path)) tmpC.lerp(WHITE, 0.45).multiplyScalar(1.25);
      ref.current.setColorAt(i, tmpC);
    });
    ref.current.instanceMatrix.needsUpdate = true;
    ref.current.instanceColor!.needsUpdate = true;
  });

  const at = (id?: number) => (id == null ? undefined : runs[id]?.file);
  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, Math.max(runs.length, 1)]}
      count={runs.length}
      frustumCulled={false}
      onPointerMove={(e) => {
        e.stopPropagation();
        const file = at(e.instanceId);
        document.body.style.cursor = file ? 'pointer' : '';
        useRace.getState().set({ hover: file ? { file, x: e.nativeEvent.clientX, y: e.nativeEvent.clientY } : null });
      }}
      onPointerOut={() => {
        document.body.style.cursor = '';
        useRace.getState().set({ hover: null });
      }}
      onClick={(e) => {
        if (e.delta > 4) return; // orbit drag, not a click
        e.stopPropagation();
        const file = at(e.instanceId);
        if (file) useRace.getState().set({ selFile: file, selected: null });
      }}
    >
      <boxGeometry />
      <meshStandardMaterial roughness={0.45} metalness={0.1} />
    </instancedMesh>
  );
}

// Most recent edit of a file within its first n touches.
function lastEditor(f: FileNode, n: number) {
  for (let k = n - 1; k >= 0; k--) if (f.touches[k].edit) return f.touches[k];
  return undefined;
}

// Filename labels: the most-edited files so far, plus whatever each agent is working on right now.
const MAX_LABELS = 10;
function FileLabels() {
  const [shown, setShown] = useState<{ files: FileNode[]; active: Set<FileNode> }>({ files: [], active: new Set() });
  const key = useRef('');
  useFrame(() => {
    const { time, map, agents, lanes, meta, editsOnly } = useRace.getState();
    const active = new Set<FileNode>();
    for (const a of agents) {
      if (time >= meta[a].totalMs) continue;
      const e = lanes[a].events[idxAt(lanes[a].events, time)];
      for (const p of e?.files ?? []) {
        const f = map.byPath.get(p);
        if (f && !(editsOnly && !f.editsAt[upper(f.touches, time) - 1])) active.add(f);
      }
    }
    const top = map.files
      .map((f) => ({ f, e: f.editsAt[upper(f.touches, time) - 1] ?? 0 }))
      .filter((x) => x.e > 0)
      .sort((x, y) => y.e - x.e)
      .slice(0, MAX_LABELS)
      .map((x) => x.f);
    const files = [...new Set([...active, ...top])];
    const k = `${files.map((f) => f.i).join(',')}|${[...active].map((f) => f.i).join(',')}`;
    if (k !== key.current) {
      key.current = k;
      setShown({ files, active });
    }
  });
  return (
    <>
      {shown.files.map((f) => (
        <FileLabel key={f.path} f={f} active={shown.active.has(f)} />
      ))}
    </>
  );
}

function FileLabel({ f, active }: { f: FileNode; active: boolean }) {
  const g = useRef<THREE.Group>(null!);
  const dot = useRef<HTMLElement>(null!);
  const delta = useRef<HTMLElement>(null!);
  useFrame(() => {
    const [x, z] = center(f);
    g.current.position.set(x, (stackH[f.i] ?? 0) + 0.35, z);
    const n = upper(f.touches, useRace.getState().time);
    const ed = lastEditor(f, n);
    if (dot.current) dot.current.style.background = ed ? AGENT_COLOR[ed.agent] : '#64748b';
    if (delta.current) {
      const add = Math.round(f.addAt[n - 1] ?? 0);
      const rem = Math.round(f.remAt[n - 1] ?? 0);
      const text = add || rem ? `+${add} −${rem}` : '';
      if (delta.current.textContent !== text) delta.current.textContent = text;
    }
  });
  return (
    <group ref={g}>
      <Html center className={active ? 'label3d file active' : 'label3d file'} zIndexRange={[15, 5]}>
        <i ref={dot} />
        {f.path.split('/').pop()}
        <em ref={delta} />
      </Html>
    </group>
  );
}

// Ring that ripples out across the map at the moment of each edit (agent color) or failed call (red).
const RINGS = 12;
function Shockwaves() {
  const files = useRace((s) => s.map.files);
  const grow = useRace((s) => Math.max(s.map.size.scale, 0.4) * 9);
  const edits = useMemo(
    () =>
      files
        .flatMap((f) => f.touches.filter((x) => x.edit || x.ev.ok === false).map((x) => ({ t: x.t, f, color: x.ev.ok === false ? FAIL_COLOR : AGENT_COLOR[x.agent] })))
        .sort((a, b) => a.t - b.t),
    [files],
  );
  const refs = useRef<THREE.Mesh[]>([]);
  useFrame(() => {
    const { time, speed, axis } = useRace.getState();
    const now = axis.toV(time);
    const life = 1400 * speed; // ~1.4s of real time
    let j = 0;
    for (let i = upper(edits, time) - 1; i >= 0 && j < RINGS; i--) {
      const age = (now - axis.toV(edits[i].t)) / life;
      if (age > 1) break;
      const m = refs.current[j++];
      const [x, z] = center(edits[i].f);
      m.visible = true;
      m.position.set(x, 0.1, z);
      m.scale.setScalar(0.6 + age * grow);
      const mat = m.material as THREE.MeshBasicMaterial;
      mat.color.set(edits[i].color).multiplyScalar(2);
      mat.opacity = (1 - age) * 0.85;
    }
    for (; j < RINGS; j++) if (refs.current[j]) refs.current[j].visible = false;
  });
  return (
    <>
      {Array.from({ length: RINGS }, (_, i) => (
        <mesh key={i} ref={(el) => void (el && (refs.current[i] = el))} rotation-x={-Math.PI / 2} visible={false} raycast={() => null}>
          <ringGeometry args={[0.88, 1, 64]} />
          <meshBasicMaterial transparent depthWrite={false} toneMapped={false} blending={THREE.AdditiveBlending} />
        </mesh>
      ))}
    </>
  );
}

const TRAIL = 14;
const UP = new THREE.Vector3(0, 1, 0);

function Bot({ agent, offset, labelY }: { agent: Agent; offset: number; labelY: number }) {
  const home = useRace((s) => s.map.size.h / 2 + 3); // waiting spot in front of the map
  const hops = useRace((s) => s.map.hops[agent]);
  const lane = useRace((s) => s.lanes[agent]);
  const meta = useRace((s) => s.meta[agent]);
  const g = useRef<THREE.Group>(null!);
  const halo = useRef<THREE.Mesh>(null!);
  const label = useRef<HTMLDivElement>(null!);
  const color = useMemo(() => new THREE.Color(AGENT_COLOR[agent]), [agent]);
  const trail = useMemo(() => new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false })), []);
  const last = useRef({ hop: -2, idx: -2, done: false });
  const beam = useRef<THREE.Mesh>(null!);
  const byPath = useRace((s) => s.map.byPath);
  const top = (f: FileNode) => {
    const [x, z] = center(f);
    return new THREE.Vector3(x + offset, stackH[f.i] ?? 0, z);
  };

  useFrame(({ clock }, dt) => {
    const { time } = useRace.getState();
    const h = upper(hops, time) - 1;
    const f = h >= 0 ? hops[h].file : null;
    const want = f ? top(f).add(new THREE.Vector3(0, 1.3, 0)) : new THREE.Vector3(offset * 4, 3, home);
    g.current.position.lerp(want, 1 - Math.exp(-dt * 6));
    g.current.position.y += Math.sin(clock.elapsedTime * 3 + offset * 4) * 0.004;
    halo.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 5) * 0.08);
    if (f) botPos[agent] = g.current.position;
    else delete botPos[agent]; // not on the map yet: follow cam ignores it

    const idx = idxAt(lane.events, time);
    const done = time >= meta.totalMs;
    if (label.current && (idx !== last.current.idx || done !== last.current.done)) {
      const e = lane.events[idx];
      label.current.textContent = done ? `${AGENT_NAME[agent]} · finished` : e ? actionText(e) : AGENT_NAME[agent];
      label.current.style.borderColor = e && !done ? (e.ok === false ? FAIL_COLOR : KIND_COLOR[e.kind]) : AGENT_COLOR[agent];
      last.current.idx = idx;
      last.current.done = done;
    }

    // Beam from the agent to the file it is acting on: thick and bright for edits, thin for reads/searches.
    const cur = lane.events[idx];
    const target = !done && cur?.files?.length ? byPath.get(cur.files[0]) : undefined;
    beam.current.visible = !!target;
    if (target) {
      const a = g.current.position;
      const b = top(target).add(new THREE.Vector3(0, 0.05, 0));
      const dir = b.clone().sub(a);
      const len = Math.max(dir.length(), 0.01);
      const isEdit = cur.kind === 'edit';
      const r = isEdit ? 0.09 + Math.sin(clock.elapsedTime * 12) * 0.02 : 0.025;
      beam.current.position.copy(a).addScaledVector(dir, 0.5);
      beam.current.quaternion.setFromUnitVectors(UP, dir.normalize());
      beam.current.scale.set(r, len, r);
      (beam.current.material as THREE.MeshBasicMaterial).color.set(KIND_COLOR[cur.kind]).multiplyScalar(isEdit ? 2.4 : 1);
    }

    if (h !== last.current.hop) {
      // Arcs between the last few files visited, fading out with age.
      last.current.hop = h;
      const pts: THREE.Vector3[] = [];
      const cols: number[] = [];
      const from = Math.max(0, h - TRAIL);
      for (let j = from; j < h; j++) {
        const p0 = top(hops[j].file).add(new THREE.Vector3(0, 0.4, 0));
        const p1 = top(hops[j + 1].file).add(new THREE.Vector3(0, 0.4, 0));
        const mid = p0.clone().add(p1).multiplyScalar(0.5);
        mid.y += 1.5 + p0.distanceTo(p1) * 0.18;
        const fade = (j - from + 1) / (h - from);
        for (const p of new THREE.QuadraticBezierCurve3(p0, mid, p1).getPoints(14)) {
          pts.push(p);
          tmpC.copy(color).multiplyScalar(0.12 + fade * 1.2);
          cols.push(tmpC.r, tmpC.g, tmpC.b);
        }
      }
      trail.geometry.dispose();
      trail.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      trail.geometry.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
    }
  });

  return (
    <>
      <primitive object={trail} />
      <mesh ref={beam} visible={false} raycast={() => null}>
        <cylinderGeometry args={[1, 1, 1, 10]} />
        <meshBasicMaterial transparent opacity={0.8} toneMapped={false} />
      </mesh>
      <group ref={g} position={[offset * 4, 3, home]}>
        <mesh>
          <sphereGeometry args={[0.45, 24, 16]} />
          <meshBasicMaterial color={color.clone().multiplyScalar(2.2)} toneMapped={false} />
        </mesh>
        <mesh ref={halo}>
          <sphereGeometry args={[0.85, 24, 16]} />
          <meshBasicMaterial color={color} transparent opacity={0.16} depthWrite={false} />
        </mesh>
        <pointLight color={color} intensity={30} distance={9} />
        <Html position={[0, labelY, 0]} center className="label3d now" zIndexRange={[20, 10]}>
          <div ref={label} />
        </Html>
      </group>
    </>
  );
}

function SelectedFile() {
  const ref = useRef<THREE.Mesh>(null!);
  useFrame(({ clock }) => {
    const f = useRace.getState().selFile;
    ref.current.visible = !!f;
    if (!f) return;
    const [x, z] = center(f);
    const h = stackH[f.i] ?? 0.1;
    const s = 1 + Math.sin(clock.elapsedTime * 6) * 0.03;
    ref.current.position.set(x, h / 2, z);
    ref.current.scale.set(f.rect.w * s, h * s + 0.15, f.rect.h * s);
  });
  return (
    <mesh ref={ref}>
      <boxGeometry />
      <meshBasicMaterial color={[3, 3, 3]} wireframe toneMapped={false} />
    </mesh>
  );
}

function CameraRig() {
  const cam = useRace((s) => s.cam);
  const controls = useRef<OrbitControlsImpl>(null!);
  const { camera, scene } = useThree();
  const look = useRef(new THREE.Vector3(0, 0, -1));
  const cs = useRace((s) => Math.max(s.map.size.scale, 0.62)); // camera distance follows map size (floor: tiles are up to 6 tall)
  useLayoutEffect(() => {
    camera.position.set(0, 39 * cs, 35 * cs);
    camera.lookAt(0, 0, -cs);
  }, [camera, cs]);
  const wantPos = useMemo(() => new THREE.Vector3(), []);
  const wantLook = useMemo(() => new THREE.Vector3(), []);
  // Director state: current shot, when it started (real ms), orbit angle for close-ups.
  const director = useRef<{ shot: Shot | null; key: string; since: number; angle: number }>({ shot: null, key: '', since: 0, angle: 0.6 });
  const reduceMotion = useMemo(() => matchMedia('(prefers-reduced-motion: reduce)').matches, []);

  useFrame((_, dt) => {
    const s = useRace.getState();
    const target = s.cam === 'overview' ? (controls.current?.target ?? look.current) : look.current;
    if (scene.fog instanceof THREE.Fog) {
      const d = camera.position.distanceTo(target);
      scene.fog.near = d + 20;
      scene.fog.far = d * 2.2 + 120;
    }
    if (s.cam === 'overview') {
      look.current.copy(target);
      return;
    }
    let k = 1 - Math.exp(-dt * 3);
    if (s.cam === 'director') {
      // What is each agent doing right now, and where?
      const focus: Focus[] = [];
      for (const a of s.agents) {
        if (s.time >= s.meta[a].totalMs) continue;
        const e = s.lanes[a].events[idxAt(s.lanes[a].events, s.time)];
        const f = e?.files?.length ? s.map.byPath.get(e.files[0]) : undefined;
        if (f) focus.push({ agent: a, path: f.path, x: f.rect.x + f.rect.w / 2, z: f.rect.y + f.rect.h / 2, prio: priority(e) });
      }
      const next = pickShot(focus, 6 * cs);
      const key = shotKey(next);
      const d = director.current;
      const held = performance.now() - d.since;
      // Hold each shot ~2.5s so the camera doesn't jitter; a fresh edit/failure may cut in after 0.8s.
      const urgent = next.focus[0]?.prio === 3 && (d.shot?.focus[0]?.prio ?? 0) < 3;
      if (!d.shot || (key !== d.key && (held > 2500 || (urgent && held > 800)))) {
        d.shot = next;
        d.key = key;
        d.since = performance.now();
        const who = next.focus.map((x) => {
          const e = s.lanes[x.agent].events[idxAt(s.lanes[x.agent].events, s.time)];
          return `${AGENT_NAME[x.agent]} ${e ? actionText(e).replace(/^\S+ /, '') : ''}`;
        });
        s.set({ shot: next.kind === 'wide' ? 'Wide · whole codebase' : `${next.kind === 'two' ? 'Two-shot' : 'Close-up'} · ${who.join('  |  ')}` });
      }
      const shot = d.shot;
      if (!reduceMotion) d.angle += dt * 0.12; // slow orbit keeps close-ups alive
      if (shot.kind === 'close') {
        const f = s.map.byPath.get(shot.focus[0].path);
        const h = f ? (stackH[f.i] ?? 0) : 0;
        const r = 13 * cs; // close enough to read the file, far enough to see its neighbours
        wantLook.set(shot.x, h * 0.5, shot.z);
        wantPos.set(shot.x + Math.sin(d.angle) * r, h + 11 * cs, shot.z + Math.cos(d.angle) * r);
      } else if (shot.kind === 'two') {
        wantLook.set(shot.x, 0, shot.z);
        wantPos.set(shot.x, shot.spread * 0.75 + 6 * cs, shot.z + shot.spread * 0.7 + 6 * cs);
      } else {
        wantLook.set(0, 0, -cs);
        wantPos.set(0, 39 * cs, 35 * cs);
      }
      k = 1 - Math.exp(-dt * 2.2); // smooth dolly between shots...
      look.current.lerp(wantLook, 1 - Math.exp(-dt * 5)); // ...but aim locks on fast so the subject stays centered
    } else if (s.cam === 'follow') {
      const ps = s.agents.map((a) => botPos[a]).filter((p): p is THREE.Vector3 => !!p);
      const mid = ps.reduce((m, p) => m.add(p), new THREE.Vector3()).multiplyScalar(1 / Math.max(ps.length, 1));
      wantLook.set(mid.x, 0, mid.z);
      wantPos.set(mid.x, 17, mid.z + 15);
    } else {
      wantLook.set(0, 0, 0);
      wantPos.set(0, 62 * cs, 0.01);
    }
    camera.position.lerp(wantPos, k);
    look.current.lerp(wantLook, k);
    camera.lookAt(look.current);
    controls.current?.target.copy(look.current); // so switching back to overview starts from here
  });

  return <OrbitControls ref={controls} target={[0, 0, -cs]} enabled={cam === 'overview'} enableDamping maxPolarAngle={Math.PI / 2.1} />;
}

export function Scene() {
  const agents = useRace((s) => s.agents);
  const empty = useRace((s) => s.map.files.length === 0);
  return (
    <div className="stage">
    <Canvas dpr={[1, 2]} camera={{ position: [0, 39, 35], fov: 45, far: 2000 }} gl={{ antialias: true }}>
      <color attach="background" args={[BG]} />
      <fog attach="fog" args={[BG, 70, 190]} />
      <ambientLight intensity={0.45} />
      <hemisphereLight args={['#9fb4ff', '#0b0d12', 0.7]} />
      <directionalLight position={[20, 40, 25]} intensity={1.3} />
      <Driver />
      <mesh rotation-x={-Math.PI / 2} position-y={-0.05}>
        <planeGeometry args={[400, 400]} />
        <meshStandardMaterial color="#0a0d13" roughness={1} />
      </mesh>
      <Districts />
      <Tiles />
      <Shockwaves />
      <FileLabels />
      <SelectedFile />
      {agents.map((a, i) => (
        <Bot key={a} agent={a} offset={agents.length > 1 ? (i ? 0.5 : -0.5) : 0} labelY={1.1 + i * 0.8} />
      ))}
      {empty && (
        <Html center position={[0, 1, 0]} className="label3d empty3d">
          No file activity found in this session. The timeline below still shows every step.
        </Html>
      )}
      <CameraRig />
      <EffectComposer>
        <Bloom mipmapBlur intensity={0.8} luminanceThreshold={0.9} luminanceSmoothing={0.2} />
      </EffectComposer>
    </Canvas>
    </div>
  );
}
