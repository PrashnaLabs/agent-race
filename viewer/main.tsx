import { StrictMode, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import type { Race } from '../src/race.ts';
import { Scene } from './Scene.tsx';
import { Hud } from './Hud.tsx';
import { init, seekBy, togglePlay, useRace, type Cam } from './store.ts';
import './style.css';

const CAMS: Cam[] = ['overview', 'follow', 'top'];

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
      else if (e.key === 'l' || e.key === 'L') s.set({ lanesOpen: !s.lanesOpen });
      else if (e.key === 'Escape') s.set({ selected: null, selFile: null });
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
