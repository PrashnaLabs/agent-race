import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { Race } from '../src/race.ts';
import { Scene } from './Scene.tsx';
import { Hud } from './Hud.tsx';
import { init, jumpTo, seekBy, toggleLanes, togglePlay, useRace, type Cam } from './store.ts';
import { isCheck, isEdit, isError } from './report.ts';
import './style.css';

const CAMS: Cam[] = ['overview', 'follow', 'top', 'director'];

function App() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey) return;
      const s = useRace.getState();
      if (e.key === ' ') {
        e.preventDefault();
        togglePlay();
      } else if (e.key === 'ArrowRight') seekBy(0.02);
      else if (e.key === 'ArrowLeft') seekBy(-0.02);
      else if (e.key === 'l' || e.key === 'L') toggleLanes();
      // e / x / t: next edit, error, test run (Shift = previous). r: report card.
      else if (e.key === 'e' || e.key === 'E') jumpTo(isEdit, e.shiftKey ? -1 : 1);
      else if (e.key === 'x' || e.key === 'X') jumpTo(isError, e.shiftKey ? -1 : 1);
      else if (e.key === 't' || e.key === 'T') jumpTo(isCheck, e.shiftKey ? -1 : 1);
      else if (e.key === 'r' || e.key === 'R') s.set({ report: !s.report, reportSeen: true });
      else if (e.key === 'Escape') s.set({ selected: null, selFile: null, report: false });
      else if (CAMS[Number(e.key) - 1]) s.set({ cam: CAMS[Number(e.key) - 1] });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <>
      <Scene />
      <Hud />
    </>
  );
}

const root = createRoot(document.getElementById('root')!);

fetch('/race.json')
  .then((r) => {
    if (!r.ok) throw new Error(`race.json: HTTP ${r.status}`);
    return r.json() as Promise<Race>;
  })
  .then((race) => {
    init(race);
    root.render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  })
  .catch((err) => {
    root.render(
      <div className="empty">
        <h1>No race loaded</h1>
        <p>{String(err.message ?? err)}</p>
        <p>
          Start one with <code>pnpm race</code>
        </p>
      </div>,
    );
  });
