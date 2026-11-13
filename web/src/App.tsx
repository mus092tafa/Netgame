import { useCallback, useEffect, useRef, useState } from 'react';
import { NetworkMap } from './map/NetworkMap.tsx';
import { ConnectionLog } from './panels/ConnectionLog.tsx';
import { Terminal } from './panels/Terminal.tsx';
import { Tutor } from './panels/Tutor.tsx';
import { useNetwork } from './useNetwork.ts';

function readPref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}
function writePref(key: string, v: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

/** Drag handle between two panels. */
function Splitter({ dir, onDrag }: { dir: 'col' | 'row'; onDrag: (delta: number) => void }) {
  const start = useRef<number | null>(null);
  return (
    <div
      className={`splitter ${dir}`}
      onPointerDown={(e) => {
        start.current = dir === 'col' ? e.clientX : e.clientY;
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }}
      onPointerMove={(e) => {
        if (start.current == null) return;
        const p = dir === 'col' ? e.clientX : e.clientY;
        onDrag(p - start.current);
        start.current = p;
      }}
      onPointerUp={() => (start.current = null)}
    />
  );
}

export function App() {
  const { state, send, echo, askTutor } = useNetwork();
  const [theme, setTheme] = useState<'dark' | 'light'>(() => readPref('netgame.theme', 'dark'));
  const [sizes, setSizes] = useState(() => readPref('netgame.panels', { side: 440, tutor: 260, log: 190 }));
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [start] = useState(Date.now());

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    writePref('netgame.theme', theme);
  }, [theme]);
  useEffect(() => writePref('netgame.panels', sizes), [sizes]);
  useEffect(() => {
    if (!activeTab && state.shells.length) setActiveTab(state.shells[0].tab);
  }, [state.shells, activeTab]);

  const resize = (k: keyof typeof sizes, d: number, min: number, max: number) =>
    setSizes((s) => ({ ...s, [k]: Math.min(max, Math.max(min, s[k] + d)) }));

  // Clicking a machine focuses the terminal tab that is on it (or rooted on it).
  const focusMachine = useCallback(
    (id: string) => {
      const tab =
        state.shells.find((s) => s.chain[s.chain.length - 1] === id) ?? state.shells.find((s) => s.root === id);
      if (tab) setActiveTab(tab.tab);
    },
    [state.shells],
  );

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">◇</span>
          <div>
            <div className="brand-name">NETWORK <i>GAME</i></div>
            <div className="brand-sub">{state.level ? `LEVEL · ${state.level.title.toUpperCase()}` : 'CONNECTING…'}</div>
          </div>
        </div>
        <div className="top-status">
          <span className={`conn-dot ${state.connected ? 'ok' : ''}`} /> {state.connected ? `LIVE · ${state.mode?.toUpperCase()}` : 'OFFLINE'}
        </div>
      </header>
      <main className="layout" style={{ gridTemplateColumns: `1fr 6px ${sizes.side}px` }}>
        <section className="left" style={{ gridTemplateRows: `1fr 6px ${sizes.log}px` }}>
          <NetworkMap
            state={state}
            activeTab={activeTab}
            theme={theme}
            onToggleTheme={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            onFocusMachine={focusMachine}
            onExplain={askTutor}
          />
          <Splitter dir="row" onDrag={(d) => resize('log', -d, 60, 500)} />
          <ConnectionLog rows={state.log} start={start} />
        </section>
        <Splitter dir="col" onDrag={(d) => resize('side', -d, 300, 900)} />
        <section className="right" style={{ gridTemplateRows: `1fr 6px ${sizes.tutor}px` }}>
          <Terminal
            shells={state.shells}
            active={activeTab}
            onActive={setActiveTab}
            output={state.term}
            mode={state.mode}
            onRun={(tab, prompt, line) => {
              echo(tab, prompt, line);
              send({ type: 'cmd', tab, line });
            }}
          />
          <Splitter dir="row" onDrag={(d) => resize('tutor', -d, 80, 700)} />
          <Tutor messages={state.tutor} />
        </section>
      </main>
    </div>
  );
}
