import { useLayoutEffect, useMemo, useRef, type ComponentRef } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Edges, Html, OrbitControls } from '@react-three/drei';
import { Bloom, EffectComposer } from '@react-three/postprocessing';
import * as THREE from 'three';
import type { Agent } from '../src/race.ts';
import { MAP_H, metricValue, upper, type FileNode } from './codemap.ts';
import { AGENT_COLOR, AGENT_NAME, BOTH_COLOR, FAIL_COLOR, KIND_COLOR, idxAt, useRace } from './store.ts';

const BG = '#07090d';
type OrbitControlsImpl = ComponentRef<typeof OrbitControls>;

// Per-frame shared state, deliberately outside React: tile heights (bots sit on them) and bot positions (follow cam).
const tileH: number[] = [];
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
    if (v >= s.axis.total) s.set({ time: s.maxMs, playing: false });
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

function Tiles() {
  const files = useRace((s) => s.map.files);
  const max = useRace((s) => s.map.max);
  const agents = useRace((s) => s.agents);
  const ref = useRef<THREE.InstancedMesh>(null!);
  const colors = useMemo(
    () => ({ both: new THREE.Color(BOTH_COLOR), ...Object.fromEntries(agents.map((a) => [a, new THREE.Color(AGENT_COLOR[a])])) }) as Record<string, THREE.Color>,
    [agents],
  );

  useLayoutEffect(() => {
    files.forEach((f, i) => {
      tileH[i] = 0.06;
      ref.current.setColorAt(i, UNTOUCHED); // allocates instanceColor
    });
  }, [files]);

  useFrame((_, dt) => {
    if (!files.length) return;
    const { time, speed, axis, selected, selFile, hover, metric } = useRace.getState();
    const k = 1 - Math.exp(-dt * 8);
    const now = axis.toV(time);
    const flash = 500 * speed; // ~0.5s of real time at any speed
    for (const f of files) {
      const n = upper(f.touches, time);
      const edits = n ? f.editsAt[n - 1] : 0;
      tileH[f.i] += ((n ? targetHeight(metricValue(f, n, metric), max[metric]) : 0.06) - tileH[f.i]) * k;
      const h = tileH[f.i];
      const gap = Math.min(0.18, f.rect.w * 0.2, f.rect.h * 0.2);
      const [cx, cz] = center(f);
      tmpP.set(cx, h / 2, cz);
      tmpS.set(Math.max(f.rect.w - gap * 2, 0.05), h, Math.max(f.rect.h - gap * 2, 0.05));
      ref.current.setMatrixAt(f.i, tmpM.compose(tmpP, tmpQ, tmpS));

      const by = agents.filter((a) => (f.first[a] ?? Infinity) <= time);
      if (!by.length) tmpC.copy(UNTOUCHED);
      else {
        tmpC.copy(by.length > 1 ? colors.both : colors[by[0]]).multiplyScalar(edits ? 1 : 0.7);
        if (now - axis.toV(f.touches[n - 1].t) < flash) tmpC.multiplyScalar(2.6); // HDR flash -> bloom
      }
      if (f === selFile || f === hover?.file || selected?.files?.includes(f.path)) tmpC.lerp(WHITE, 0.5).multiplyScalar(1.3);
      ref.current.setColorAt(f.i, tmpC);
    }
    ref.current.instanceMatrix.needsUpdate = true;
    ref.current.instanceColor!.needsUpdate = true;
  });

  const at = (id?: number) => (id == null ? undefined : files[id]);
  return (
    <instancedMesh
      ref={ref}
      args={[undefined, undefined, Math.max(files.length, 1)]}
      count={files.length}
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

const TRAIL = 14;

function Bot({ agent, offset }: { agent: Agent; offset: number }) {
  const hops = useRace((s) => s.map.hops[agent]);
  const lane = useRace((s) => s.lanes[agent]);
  const meta = useRace((s) => s.meta[agent]);
  const g = useRef<THREE.Group>(null!);
  const halo = useRef<THREE.Mesh>(null!);
  const label = useRef<HTMLDivElement>(null!);
  const color = useMemo(() => new THREE.Color(AGENT_COLOR[agent]), [agent]);
  const trail = useMemo(() => new THREE.Line(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true, toneMapped: false })), []);
  const last = useRef({ hop: -2, idx: -2, done: false });
  const top = (f: FileNode) => {
    const [x, z] = center(f);
    return new THREE.Vector3(x + offset, tileH[f.i] ?? 0, z);
  };

  useFrame(({ clock }, dt) => {
    const { time } = useRace.getState();
    const h = upper(hops, time) - 1;
    const f = h >= 0 ? hops[h].file : null;
    const want = f ? top(f).add(new THREE.Vector3(0, 1.3, 0)) : new THREE.Vector3(offset * 4, 3, MAP_H / 2 + 3);
    g.current.position.lerp(want, 1 - Math.exp(-dt * 6));
    g.current.position.y += Math.sin(clock.elapsedTime * 3 + offset * 4) * 0.004;
    halo.current.scale.setScalar(1 + Math.sin(clock.elapsedTime * 5) * 0.08);
    if (f) botPos[agent] = g.current.position;
    else delete botPos[agent]; // not on the map yet: follow cam ignores it

    const idx = idxAt(lane.events, time);
    const done = time >= meta.totalMs;
    if (label.current && (idx !== last.current.idx || done !== last.current.done)) {
      const e = lane.events[idx];
      label.current.textContent = done ? `${AGENT_NAME[agent]} · finished` : (e?.summary ?? AGENT_NAME[agent]);
      label.current.style.borderColor = e && !done ? (e.ok === false ? FAIL_COLOR : KIND_COLOR[e.kind]) : AGENT_COLOR[agent];
      last.current.idx = idx;
      last.current.done = done;
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
      <group ref={g} position={[offset * 4, 3, MAP_H / 2 + 3]}>
        <mesh>
          <sphereGeometry args={[0.45, 24, 16]} />
          <meshBasicMaterial color={color.clone().multiplyScalar(2.2)} toneMapped={false} />
        </mesh>
        <mesh ref={halo}>
          <sphereGeometry args={[0.85, 24, 16]} />
          <meshBasicMaterial color={color} transparent opacity={0.16} depthWrite={false} />
        </mesh>
        <pointLight color={color} intensity={30} distance={9} />
        <Html position={[0, 1.1, 0]} center className="label3d now" zIndexRange={[20, 10]}>
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
    const h = tileH[f.i] ?? 0.1;
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
  const wantPos = useMemo(() => new THREE.Vector3(), []);
  const wantLook = useMemo(() => new THREE.Vector3(), []);

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
    if (s.cam === 'follow') {
      const ps = s.agents.map((a) => botPos[a]).filter((p): p is THREE.Vector3 => !!p);
      const mid = ps.reduce((m, p) => m.add(p), new THREE.Vector3()).multiplyScalar(1 / Math.max(ps.length, 1));
      wantLook.set(mid.x, 0, mid.z);
      wantPos.set(mid.x, 17, mid.z + 15);
    } else {
      wantLook.set(0, 0, 0);
      wantPos.set(0, 62, 0.01);
    }
    const k = 1 - Math.exp(-dt * 3);
    camera.position.lerp(wantPos, k);
    look.current.lerp(wantLook, k);
    camera.lookAt(look.current);
    controls.current?.target.copy(look.current); // so switching back to overview starts from here
  });

  return <OrbitControls ref={controls} target={[0, 0, -1]} enabled={cam === 'overview'} enableDamping maxPolarAngle={Math.PI / 2.1} />;
}

export function Scene() {
  const agents = useRace((s) => s.agents);
  const empty = useRace((s) => s.map.files.length === 0);
  return (
    <div className="stage">
    <Canvas dpr={[1, 2]} camera={{ position: [0, 44, 40], fov: 45, far: 2000 }} gl={{ antialias: true }}>
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
      <SelectedFile />
      {agents.map((a, i) => (
        <Bot key={a} agent={a} offset={agents.length > 1 ? (i ? 0.5 : -0.5) : 0} />
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
