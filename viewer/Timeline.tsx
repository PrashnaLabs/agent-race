// 2D timeline under the code map. Compact: scrub strip. Expanded: zoomable swimlanes (wheel zoom, drag pan, click a bar).
import { useEffect, useRef } from 'react';
import { KINDS, type RaceEvent } from '../src/race.ts';
import { AGENT_COLOR, AGENT_NAME, evColor, fmtMs, isFull, useRace } from './store.ts';

const TICK_STEPS = [1e3, 5e3, 10e3, 30e3, 60e3, 120e3, 300e3, 600e3, 900e3, 1800e3, 3600e3, 7200e3];
const AXIS = 20;
type Hit = [x: number, y: number, w: number, h: number, e: RaceEvent];

export function Timeline() {
  const ref = useRef<HTMLCanvasElement>(null!);
  const view = useRef({ v0: 0, v1: 1, hits: [] as Hit[], drag: null as null | { x: number; v0: number; v1: number; moved: boolean } });
  const open = useRace((s) => isFull(s.tlH));
  const axis = useRace((s) => s.axis);

  useEffect(() => {
    view.current.v0 = 0;
    view.current.v1 = axis.total;
  }, [axis, open]);

  useEffect(() => {
    const el = ref.current;
    const ctx = el.getContext('2d')!;
    const vw = view.current;
    // Agent names run vertically down a thin left strip; swimlanes also need room for event-type labels.
    const labelW = () => (isFull(useRace.getState().tlH) ? 86 : 26);
    const plotW = () => el.clientWidth - labelW() - 12;
    const vx = (v: number) => labelW() + ((v - vw.v0) / (vw.v1 - vw.v0)) * plotW();
    const xv = (x: number) => vw.v0 + ((x - labelW()) / plotW()) * (vw.v1 - vw.v0);

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const s = useRace.getState();
      const { axis: ax, agents, lanes, meta, time, hidden, selected, hover } = s;
      const full = isFull(s.tlH);
      if (!full) {
        vw.v0 = 0;
        vw.v1 = ax.total;
      }
      const dpr = Math.min(devicePixelRatio, 2);
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (!W || !H) return;
      if (el.width !== Math.round(W * dpr) || el.height !== Math.round(H * dpr)) {
        el.width = Math.round(W * dpr);
        el.height = Math.round(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      const LW = labelW();
      const laneH = (H - AXIS - 4) / agents.length;
      const head = full ? 20 : 3;
      const rowH = (laneH - head - 4) / KINDS.length;
      vw.hits = [];
      ctx.font = '10px ui-monospace, Menlo, monospace';

      ctx.save();
      ctx.beginPath();
      ctx.rect(LW, 0, W - LW, H);
      ctx.clip();
      // squeezed idle stretches
      for (const g of ax.gaps) {
        const a = vx(g.v0);
        const b = vx(g.v1);
        ctx.fillStyle = 'rgba(255,255,255,0.035)';
        ctx.fillRect(a, AXIS, b - a, H - AXIS);
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        for (let x = a - H; x < b; x += 6) {
          ctx.beginPath();
          ctx.moveTo(Math.max(x, a), AXIS + Math.max(0, a - x));
          ctx.lineTo(Math.min(x + H, b), AXIS + Math.min(H, b - x));
          ctx.stroke();
        }
        if (b - a > 50) {
          ctx.fillStyle = '#6f7b93';
          ctx.fillText(`${fmtMs(g.ms)} idle`, a + 4, AXIS + 11);
        }
      }
      // ticks in real time, skipping squeezed stretches
      const tA = ax.toT(vw.v0);
      const tB = ax.toT(vw.v1);
      const step = TICK_STEPS.find((st) => (tB - tA) / st <= 9) ?? 7200e3;
      let lastX = -1e9;
      for (let t = Math.ceil(tA / step) * step; t <= tB; t += step) {
        if (ax.inGap(t)) continue;
        const x = vx(ax.toV(t));
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        ctx.fillRect(x, AXIS, 1, H - AXIS);
        if (x - lastX > 48) {
          ctx.fillStyle = '#6f7b93';
          ctx.fillText(fmtMs(t), x + 3, 13);
          lastX = x;
        }
      }
      ctx.restore();

      agents.forEach((a, li) => {
        const top = AXIS + 2 + li * laneH;
        ctx.fillStyle = li % 2 ? 'rgba(255,255,255,0.015)' : 'rgba(255,255,255,0.03)';
        ctx.fillRect(0, top, W, laneH - 2);
        // vertical name, centered in the lane (short form when the lane is too short)
        ctx.fillStyle = AGENT_COLOR[a];
        ctx.fillRect(0, top, 3, laneH - 2);
        ctx.font = '600 11px system-ui, sans-serif';
        const name = ctx.measureText(AGENT_NAME[a]).width <= laneH - 10 ? AGENT_NAME[a] : AGENT_NAME[a].split(' ')[0];
        ctx.save();
        ctx.translate(15, top + (laneH - 2) / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(name, 0, 0);
        ctx.restore();
        ctx.font = '10px ui-monospace, Menlo, monospace';
        if (full) {
          KINDS.forEach((k, ki) => {
            if (rowH < 9) return;
            ctx.fillStyle = hidden.includes(k) ? '#2f3646' : '#56607a';
            ctx.fillText(k, 28, top + head + ki * rowH + rowH * 0.75);
          });
          const m = meta[a];
          ctx.fillStyle = '#6f7b93';
          ctx.fillText(`${m.steps} steps · ${fmtMs(m.totalMs)} · ${m.totalTokens.toLocaleString()} out tokens${m.model ? ` · ${m.model}` : ''}`, LW, top + 14);
        }
        ctx.save();
        ctx.beginPath();
        ctx.rect(LW, top, W - LW, laneH);
        ctx.clip();
        for (const e of lanes[a].events) {
          if (hidden.includes(e.kind)) continue;
          const x = vx(ax.toV(e.t));
          const x2 = vx(ax.toV(e.t + e.dur));
          if (x2 < LW || x > W) continue;
          const w = Math.max(x2 - x, full ? 2 : 1.2);
          const y = top + head + KINDS.indexOf(e.kind) * rowH;
          const h = Math.max(rowH - (full ? 2 : 0.5), 1);
          ctx.globalAlpha = e.t <= time ? 1 : 0.2;
          ctx.fillStyle = evColor(e);
          ctx.fillRect(x, y, w, h);
          if (e === selected || e === hover?.ev) {
            ctx.globalAlpha = 1;
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
          }
          vw.hits.push([x, y, w, h, e]);
        }
        ctx.restore();
        ctx.globalAlpha = 1;
      });

      const px = vx(ax.toV(time));
      if (px >= LW) {
        ctx.fillStyle = '#fff';
        ctx.fillRect(px - 0.75, AXIS - 4, 1.5, H - AXIS + 4);
        ctx.beginPath();
        ctx.moveTo(px - 5, AXIS - 8);
        ctx.lineTo(px + 5, AXIS - 8);
        ctx.lineTo(px, AXIS - 2);
        ctx.fill();
      }
    };
    raf = requestAnimationFrame(draw);

    const hitAt = (x: number, y: number) => {
      for (let i = vw.hits.length - 1; i >= 0; i--) {
        const [hx, hy, w, h, e] = vw.hits[i];
        if (x >= hx - 2 && x <= hx + w + 2 && y >= hy && y <= hy + h) return e;
      }
      return null;
    };
    const total = () => useRace.getState().axis.total;
    const clamp = () => {
      const span = Math.min(Math.max(vw.v1 - vw.v0, 2000), total());
      vw.v0 = Math.min(Math.max(vw.v0, 0), total() - span);
      vw.v1 = vw.v0 + span;
    };
    const scrubTo = (x: number) => {
      const s = useRace.getState();
      s.set({ time: s.axis.toT(Math.min(Math.max(0, xv(x)), s.axis.total)) });
    };
    const fullNow = () => isFull(useRace.getState().tlH);

    const down = (ev: PointerEvent) => {
      el.setPointerCapture(ev.pointerId);
      vw.drag = { x: ev.offsetX, v0: vw.v0, v1: vw.v1, moved: false };
      if (!fullNow()) scrubTo(ev.offsetX);
    };
    const move = (ev: PointerEvent) => {
      const d = vw.drag;
      if (d) {
        const dx = ev.offsetX - d.x;
        if (Math.abs(dx) > 3) d.moved = true;
        if (fullNow()) {
          const dv = (dx / plotW()) * (d.v1 - d.v0);
          vw.v0 = d.v0 - dv;
          vw.v1 = d.v1 - dv;
          clamp();
        } else scrubTo(ev.offsetX);
        return;
      }
      const e = hitAt(ev.offsetX, ev.offsetY);
      useRace.getState().set({ hover: e ? { ev: e, x: ev.clientX, y: ev.clientY } : null });
    };
    const up = (ev: PointerEvent) => {
      const d = vw.drag;
      vw.drag = null;
      if (!d || d.moved || !fullNow()) return;
      const e = hitAt(ev.offsetX, ev.offsetY);
      if (e) useRace.getState().set({ selected: e, selFile: null });
      else scrubTo(ev.offsetX);
    };
    const leave = () => useRace.getState().set({ hover: null });
    const wheel = (ev: WheelEvent) => {
      if (!fullNow()) return;
      ev.preventDefault();
      const f = Math.exp(ev.deltaY * 0.0015);
      const c = xv(ev.offsetX);
      vw.v0 = c - (c - vw.v0) * f;
      vw.v1 = c + (vw.v1 - c) * f;
      clamp();
    };
    const reset = () => {
      vw.v0 = 0;
      vw.v1 = total();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointerleave', leave);
    el.addEventListener('wheel', wheel, { passive: false });
    el.addEventListener('dblclick', reset);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointerleave', leave);
      el.removeEventListener('wheel', wheel);
      el.removeEventListener('dblclick', reset);
    };
  }, []);

  return <canvas ref={ref} className={open ? 'timeline full' : 'timeline'} aria-label="Session timeline" />;
}
