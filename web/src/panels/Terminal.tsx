import { useEffect, useRef, useState } from 'react';
import type { ShellInfo } from '../../../shared/protocol.ts';

const SUGGESTIONS = ['help', 'ssh web-01', 'curl http://web-01/', 'curl web-01:8080', 'curl https://web-01', 'ping -c 2 web-01', 'ssh db-01', 'psql -h db-01 -U app', 'ss -tunap', 'exit'];

interface Props {
  shells: ShellInfo[];
  active: string | null;
  onActive: (tab: string) => void;
  output: Record<string, string>;
  mode: 'sim' | 'docker' | null;
  onRun: (tab: string, prompt: string, line: string) => void;
}

export function Terminal({ shells, active, onActive, output, mode, onRun }: Props) {
  const [line, setLine] = useState('');
  const [hist, setHist] = useState<string[]>([]);
  const [hi, setHi] = useState(-1);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const shell = shells.find((s) => s.tab === active) ?? shells[0];

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [output, active]);

  useEffect(() => {
    input.current?.focus();
  }, [active]);

  if (mode === 'docker' && !shells.length) {
    return (
      <div className="panel terminal">
        <div className="panel-title">TERMINAL</div>
        <div className="term-body muted">No machine in this level has <code>terminal: true</code>.</div>
      </div>
    );
  }
  // The Docker terminal has no PTY, so psql needs its query on the command line.
  const suggestions = mode === 'docker' ? SUGGESTIONS.map((s) => (s.startsWith('psql') ? `${s} -c 'select 1'` : s)) : SUGGESTIONS;

  const run = (cmd: string) => {
    if (!shell) return;
    onRun(shell.tab, shell.prompt, cmd);
    if (cmd.trim()) setHist((h) => [...h.filter((x) => x !== cmd), cmd].slice(-50));
    setHi(-1);
    setLine('');
  };

  return (
    <div className="panel terminal" onClick={() => input.current?.focus()}>
      <div className="panel-title">
        TERMINAL
        <div className="tabs">
          {shells.map((s) => (
            <button key={s.tab} className={`tab ${s.tab === shell?.tab ? 'on' : ''}`} onClick={() => onActive(s.tab)}>
              {s.root}
              {s.chain.length > 1 && <span className="muted"> → {s.chain.slice(1).join(' → ')}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="term-body" ref={scroller}>
        <pre>{shell ? output[shell.tab] ?? '' : ''}</pre>
        {shell && (
          <div className="term-line">
            <span className="prompt">{shell.prompt}</span>
            <input
              ref={input}
              value={line}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setLine(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') run(line);
                else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  const i = hi < 0 ? hist.length - 1 : Math.max(0, hi - 1);
                  if (hist[i] !== undefined) { setHi(i); setLine(hist[i]); }
                } else if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  const i = hi < 0 ? -1 : hi + 1;
                  if (i < 0 || i >= hist.length) { setHi(-1); setLine(''); }
                  else { setHi(i); setLine(hist[i]); }
                } else if (e.key === 'l' && e.ctrlKey) {
                  e.preventDefault();
                  run('clear');
                }
              }}
            />
          </div>
        )}
      </div>
      <div className="chips">
        {suggestions.map((s) => (
          <button key={s} className="chip" onClick={(e) => { e.stopPropagation(); run(s); }}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}
