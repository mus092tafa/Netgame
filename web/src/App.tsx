import { useCallback, useEffect, useRef, useState } from 'react';
import { explainCommand, formatCommandHelp } from '../../shared/commandHelp.ts';
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
  const { state, send, term, askTutor, tutorSay, resetProgress } = useNetwork();
  const [theme, setTheme] = useState<'dark' | 'light'>(() => readPref('netgame.theme', 'dark'));
  const [sizes, setSizes] = useState(() => readPref('netgame.panels', { side: 440, tutor: 260, log: 190 }));
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const [start] = useState(Date.now());
  // Lets the tasks panel type into the terminal: tab → (command, press Enter?).
  const terminals = useRef(new Map<string, (cmd: string, enter: boolean) => void>()).current;

  // The task picked in the tasks panel, remembered per level. Starts at the first one not done yet.
  const levelId = state.level?.id;
  const [picked, setPicked] = useState<number | null>(null);
  const pick = useCallback(
    (i: number) => {
      setPicked(i);
      if (levelId) writePref(`netgame.task.${levelId}`, i);
    },
    [levelId],
  );
  const firstOpen = Math.max(0, state.targets.findIndex((_, i) => !state.achieved.has(i)));
  const task = picked != null && picked < state.targets.length ? picked : firstOpen;
  // Pinned once the level is known, so finishing a task shows its ✓ before moving on (below).
  const ready = !!levelId && state.targets.length > 0;
  useEffect(() => {
    if (ready) setPicked(readPref<number | null>(`netgame.task.${levelId}`, null) ?? firstOpen);
    // Only when the level changes: picking a task later must not be overridden.
  }, [ready, levelId]);

  // Finishing the picked task moves on to the next one not done yet (after its ✓ shows for a moment).
  useEffect(() => {
    if (!state.justAchieved.has(task)) return;
    const n = state.targets.length;
    const next = [...Array(n).keys()].map((k) => (task + 1 + k) % n).find((i) => !state.achieved.has(i));
    if (next == null) return;
    const t = setTimeout(() => pick(next), 1500);
    return () => clearTimeout(t);
  }, [state.justAchieved, state.achieved, state.targets.length, task, pick]);

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
            onExplainCommand={(cmd) => {
              const help = explainCommand(cmd);
              if (help) tutorSay(`What does \`${cmd}\` mean?`, formatCommandHelp(cmd, help));
            }}
            onTypeCommand={(cmd) => {
              const tab = activeTab ?? state.shells[0]?.tab;
              if (tab) terminals.get(tab)?.(cmd, false);
            }}
            task={task}
            onTask={pick}
            onResetProgress={() => {
              resetProgress();
              pick(0);
            }}
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
            mode={state.terminal}
            bus={term}
            theme={theme}
            send={send}
            runners={terminals}
          />
          <Splitter dir="row" onDrag={(d) => resize('tutor', -d, 80, 700)} />
          <Tutor messages={state.tutor} />
        </section>
      </main>
    </div>
  );
}
