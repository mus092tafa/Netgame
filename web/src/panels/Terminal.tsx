// Terminal panel: one xterm.js terminal per tab.
//   pty  (Docker mode): a real bash in the machine. Every keystroke goes to the server as-is.
//   line (simulator):   the simulator understands whole lines, so editing happens here.
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';
import type { ClientMsg, ShellInfo } from '../../../shared/protocol.ts';
import type { TermBus } from '../useNetwork.ts';

const SUGGESTIONS = ['ssh web-01', 'curl http://web-01/', 'curl web-01:8080', 'curl https://web-01', 'ping -c 2 web-01', 'ssh db-01', 'psql -h db-01 -U app', 'ss -tunap', 'exit'];

type Mode = 'pty' | 'line';

interface Props {
  shells: ShellInfo[];
  active: string | null;
  onActive: (tab: string) => void;
  mode: Mode | null;
  bus: TermBus;
  theme: 'dark' | 'light';
  send: (msg: ClientMsg) => void;
}

/** xterm can't read CSS variables, so the colors are copied from the current theme. */
function xtermTheme(): ITheme {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string) => css.getPropertyValue(name).trim();
  return {
    background: v('--bg'),
    foreground: v('--text'),
    cursor: v('--c-ssh'),
    cursorAccent: v('--bg'),
    selectionBackground: `${v('--accent-2')}66`,
  };
}

/** "dev@laptop:~$ " drawn like bash's default colored prompt. */
function colorPrompt(p: string) {
  const m = p.match(/^(.*?):(.*?)([$#] )$/);
  return m ? `\x1b[1;32m${m[1]}\x1b[0m:\x1b[1;34m${m[2]}\x1b[0m${m[3]}` : p;
}

/** Minimal line editing for the simulator: typing, backspace, history, Ctrl+C, Ctrl+L. */
class LineEditor {
  line = '';
  waiting = false;
  private hist: string[] = [];
  private hi = -1;

  constructor(
    private term: XTerm,
    private prompt: () => string,
    private submit: (line: string) => void,
  ) {}

  showPrompt() {
    this.term.write(colorPrompt(this.prompt()) + this.line);
  }

  /** Called when the server is done with the last command (it sends the new prompt's shell info). */
  ready() {
    if (!this.waiting) return;
    this.waiting = false;
    this.showPrompt();
  }

  run(line: string) {
    if (this.waiting) return;
    this.replace(line);
    this.enter();
  }

  key(data: string) {
    if (data === '\x03') {
      // Ctrl+C: drop the line (the simulator's commands can't be interrupted).
      this.term.write('^C\r\n');
      this.line = '';
      this.waiting = false;
      this.showPrompt();
      return;
    }
    if (this.waiting) return;
    if (data === '\x1b[A' || data === '\x1b[B') return this.history(data === '\x1b[A' ? -1 : 1);
    if (data === '\x0c') {
      this.term.reset();
      this.showPrompt();
      return;
    }
    for (const ch of data) {
      if (ch === '\r') return this.enter();
      if (ch === '\x7f' || ch === '\b') {
        if (this.line) {
          this.line = this.line.slice(0, -1);
          this.term.write('\b \b');
        }
      } else if (ch >= ' ' && ch !== '\x7f') {
        this.line += ch;
        this.term.write(ch);
      }
    }
  }

  private enter() {
    const line = this.line;
    this.line = '';
    this.hi = -1;
    this.term.write('\r\n');
    if (!line.trim()) return this.showPrompt();
    this.hist = [...this.hist.filter((h) => h !== line), line].slice(-100);
    this.waiting = true;
    this.submit(line);
  }

  private history(dir: number) {
    if (!this.hist.length) return;
    const i = this.hi < 0 ? (dir < 0 ? this.hist.length - 1 : -1) : this.hi + dir;
    if (i < 0 || i >= this.hist.length) {
      this.hi = -1;
      this.replace('');
    } else {
      this.hi = i;
      this.replace(this.hist[i]);
    }
  }

  private replace(text: string) {
    this.term.write('\b \b'.repeat(this.line.length) + text);
    this.line = text;
  }
}

interface ViewProps {
  shell: ShellInfo;
  mode: Mode;
  bus: TermBus;
  theme: Props['theme'];
  visible: boolean;
  send: Props['send'];
  /** Lets the suggestion chips type into this terminal. */
  runners: Map<string, (cmd: string) => void>;
}

function TermView({ shell, mode, bus, theme, visible, send, runners }: ViewProps) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const editorRef = useRef<LineEditor | null>(null);
  const shellRef = useRef(shell);
  shellRef.current = shell;
  const tab = shell.tab;

  useEffect(() => {
    const term = new XTerm({
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
      fontSize: 12.5,
      cursorBlink: true,
      convertEol: mode === 'line', // the simulator prints bare \n
      scrollback: 5000,
      theme: xtermTheme(),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    termRef.current = term;
    fitRef.current = fit;

    // Ctrl+Shift+C / Ctrl+Shift+V copy and paste, like desktop terminals (plain Ctrl+C is SIGINT).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== 'keydown' || !e.ctrlKey || !e.shiftKey) return true;
      if (e.code === 'KeyC') {
        if (term.hasSelection()) void navigator.clipboard?.writeText(term.getSelection());
        return false;
      }
      if (e.code === 'KeyV') {
        void navigator.clipboard?.readText().then((t) => t && term.paste(t));
        return false;
      }
      return true;
    });

    const editor =
      mode === 'line'
        ? new LineEditor(term, () => shellRef.current.prompt, (line) => send({ type: 'cmd', tab, line }))
        : null;
    editorRef.current = editor;

    term.write(bus.read(tab));
    editor?.showPrompt();
    const off = bus.subscribe((t, text, reset) => {
      if (t !== tab) return;
      if (reset) term.reset();
      term.write(text);
    });
    const input = term.onData((data) => {
      if (editor) editor.key(data);
      else send({ type: 'term-input', tab, data });
    });
    const size = term.onResize(({ cols, rows }) => {
      if (mode === 'pty') send({ type: 'term-resize', tab, cols, rows });
    });
    runners.set(tab, (cmd) => {
      term.focus();
      if (editor) editor.run(cmd);
      else send({ type: 'term-input', tab, data: `${cmd}\r` });
    });

    const observer = new ResizeObserver(() => {
      if (host.current?.offsetWidth) fit.fit();
    });
    observer.observe(host.current!);
    if (host.current?.offsetWidth) fit.fit();
    if (mode === 'pty') send({ type: 'term-resize', tab, cols: term.cols, rows: term.rows });

    return () => {
      observer.disconnect();
      off();
      input.dispose();
      size.dispose();
      runners.delete(tab);
      term.dispose();
      termRef.current = null;
      editorRef.current = null;
    };
  }, [tab, mode, bus, send, runners]);

  // The server sends fresh shell info after every simulator command: time for the next prompt.
  useEffect(() => editorRef.current?.ready(), [shell]);

  // App applies the theme to <html> in its own effect, which runs after this one.
  useEffect(() => {
    const id = requestAnimationFrame(() => termRef.current && (termRef.current.options.theme = xtermTheme()));
    return () => cancelAnimationFrame(id);
  }, [theme]);

  useEffect(() => {
    if (!visible) return;
    fitRef.current?.fit();
    termRef.current?.focus();
  }, [visible]);

  return <div className="term-body" ref={host} style={visible ? undefined : { display: 'none' }} />;
}

export function Terminal({ shells, active, onActive, mode, bus, theme, send }: Props) {
  const runners = useRef(new Map<string, (cmd: string) => void>()).current;
  const shell = shells.find((s) => s.tab === active) ?? shells[0];

  if (mode && !shells.length) {
    return (
      <div className="panel terminal">
        <div className="panel-title">TERMINAL</div>
        <div className="term-body muted">No machine in this level has <code>terminal: true</code>.</div>
      </div>
    );
  }

  return (
    <div className="panel terminal">
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
      {mode &&
        shells.map((s) => (
          <TermView key={`${mode}:${s.tab}`} shell={s} mode={mode} bus={bus} theme={theme} visible={s.tab === shell?.tab} send={send} runners={runners} />
        ))}
      <div className="chips">
        {(mode === 'line' ? ['help', ...SUGGESTIONS] : SUGGESTIONS).map((c) => (
          <button key={c} className="chip" onClick={() => shell && runners.get(shell.tab)?.(c)}>
            {c}
          </button>
        ))}
      </div>
    </div>
  );
}
