// Real terminal for Docker mode: an interactive `bash -l` with a TTY inside the machine's container,
// streamed to the browser (xterm.js). Anything works: interactive psql, vim, top, Ctrl+C, tab completion.
//
// It talks to the Docker Engine API directly (exec with Tty + attach), because `docker exec -it`
// needs a terminal on our side and a PTY library would need native builds on every OS.
// Commands reach the map through the shell hook's markers (see shellTap.ts).
import { execFileSync } from 'node:child_process';
import { request, type RequestOptions } from 'node:http';
import type { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { ShellInfo } from '../../../shared/protocol.ts';
import type { Level } from '../level.ts';
import { ShellTap, type FinishedCommand } from '../shellTap.ts';

const SCROLLBACK = 256 * 1024;
const RETRY_MS = 3000;

/** Where the Docker daemon listens: $DOCKER_HOST, else the current `docker context`. */
function dockerEndpoint(): Pick<RequestOptions, 'socketPath' | 'host' | 'port'> {
  let host = process.env.DOCKER_HOST ?? '';
  if (!host) {
    try {
      host = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], { encoding: 'utf8' }).trim();
    } catch {
      /* fall through to the default socket */
    }
  }
  if (!host) host = process.platform === 'win32' ? 'npipe:////./pipe/docker_engine' : 'unix:///var/run/docker.sock';
  if (host.startsWith('unix://')) return { socketPath: host.slice('unix://'.length) };
  if (host.startsWith('npipe://')) return { socketPath: host.slice('npipe://'.length).replace(/\//g, '\\') };
  const url = new URL(host.replace(/^tcp:/, 'http:'));
  return { host: url.hostname, port: Number(url.port || 2375) };
}

function api<T>(endpoint: RequestOptions, method: string, path: string, body?: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = request({ ...endpoint, method, path, headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (data += d));
      res.on('end', () => {
        if ((res.statusCode ?? 500) >= 300) return reject(new Error(dockerError(data) || `Docker API ${res.statusCode}`));
        resolve((data ? JSON.parse(data) : {}) as T);
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function dockerError(data: string): string {
  try {
    return (JSON.parse(data) as { message?: string }).message ?? data;
  } catch {
    return data;
  }
}

/** Starts an exec and returns the raw TTY stream (stdin and stdout on one socket). */
function attach(endpoint: RequestOptions, execId: string, cols: number, rows: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const req = request({
      ...endpoint,
      method: 'POST',
      path: `/exec/${execId}/start`,
      headers: { 'content-type': 'application/json', connection: 'Upgrade', upgrade: 'tcp' },
    });
    req.on('upgrade', (_res, socket, head) => {
      if (head.length) socket.unshift(head);
      resolve(socket as Socket);
    });
    req.on('response', (res) => {
      let data = '';
      res.on('data', (d) => (data += d));
      res.on('end', () => reject(new Error(dockerError(data) || `Docker API ${res.statusCode}`)));
    });
    req.on('error', reject);
    req.end(JSON.stringify({ Detach: false, Tty: true, ConsoleSize: [rows, cols] }));
  });
}

interface Session {
  tab: string;
  root: string;
  user: string;
  /** Machines in the ssh chain, root first, as told by the prompts. */
  chain: string[];
  /** User at each step of the chain. */
  users: string[];
  socket: Socket | null;
  execId: string | null;
  cols: number;
  rows: number;
  scrollback: string;
  tap: ShellTap;
  starting: boolean;
  closed: boolean;
  /** Last error shown, so retries don't print it again every few seconds. */
  error: string | null;
}

export interface DockerTerminalEvents {
  /** Terminal output to show (markers already removed). */
  output(tab: string, text: string): void;
  /** A command finished somewhere in the chain. */
  command(cmd: FinishedCommand): void;
  /** The shell moved to another machine (ssh / exit) or showed a new prompt. */
  prompt(): void;
}

export class DockerTerminals {
  private endpoint = dockerEndpoint();
  private sessions = new Map<string, Session>();

  constructor(
    level: Level,
    /** Edge id of the live SSH connection between two machines, if polling has seen it. */
    private findEdge: (client: string, server: string, port: number) => string | null,
    private on: DockerTerminalEvents,
  ) {
    for (const m of level.machines) {
      if (!m.terminal) continue;
      const s: Session = {
        tab: m.id, root: m.id, user: m.user, chain: [m.id], users: [m.user],
        socket: null, execId: null, cols: 80, rows: 24, scrollback: '', starting: false, closed: false, error: null,
        tap: new ShellTap(
          (cmd) => this.on.command(cmd),
          (machine, user) => this.moved(s, machine, user),
        ),
      };
      this.sessions.set(m.id, s);
    }
  }

  shells(): ShellInfo[] {
    return [...this.sessions.values()].map((s) => ({
      tab: s.tab,
      root: s.root,
      chain: s.chain,
      hopEdges: s.chain.slice(1).map((m, i) => this.findEdge(s.chain[i], m, 22)),
      prompt: `${s.users[s.users.length - 1]}@${s.chain[s.chain.length - 1]}:~$ `,
    }));
  }

  /** Recent output of every tab, for a browser that just connected. */
  replay(): { tab: string; text: string }[] {
    return [...this.sessions.values()].map((s) => ({ tab: s.tab, text: s.scrollback }));
  }

  /** Opens the shells that aren't open yet. Called when a browser connects. */
  ensure() {
    for (const s of this.sessions.values()) void this.open(s);
  }

  input(tab: string, data: string) {
    const s = this.sessions.get(tab);
    if (!s) return;
    if (s.socket) s.socket.write(data);
    else void this.open(s);
  }

  resize(tab: string, cols: number, rows: number) {
    const s = this.sessions.get(tab);
    if (!s || !(cols > 0 && rows > 0)) return;
    s.cols = Math.min(500, Math.floor(cols));
    s.rows = Math.min(200, Math.floor(rows));
    if (s.execId) api(this.endpoint, 'POST', `/exec/${s.execId}/resize?h=${s.rows}&w=${s.cols}`).catch(() => {});
  }

  closeAll() {
    for (const s of this.sessions.values()) {
      s.closed = true;
      s.socket?.destroy();
    }
  }

  private emit(s: Session, text: string) {
    if (!text) return;
    s.scrollback += text;
    if (s.scrollback.length > SCROLLBACK) {
      // Cut at a line start so the replay doesn't begin inside an escape sequence.
      const cut = s.scrollback.indexOf('\n', s.scrollback.length - SCROLLBACK);
      s.scrollback = s.scrollback.slice(cut < 0 ? s.scrollback.length - SCROLLBACK : cut + 1);
    }
    this.on.output(s.tab, text);
  }

  private moved(s: Session, machine: string, user: string) {
    const i = s.chain.indexOf(machine);
    if (i >= 0) {
      s.chain = s.chain.slice(0, i + 1);
      s.users = [...s.users.slice(0, i), user];
    } else {
      s.chain = [...s.chain, machine];
      s.users = [...s.users, user];
    }
    this.on.prompt();
  }

  private async open(s: Session) {
    if (s.socket || s.starting || s.closed) return;
    s.starting = true;
    try {
      const exec = await api<{ Id: string }>(this.endpoint, 'POST', `/containers/${encodeURIComponent(s.root)}/exec`, {
        AttachStdin: true, AttachStdout: true, AttachStderr: true, Tty: true,
        User: s.user, WorkingDir: s.user === 'root' ? '/root' : `/home/${s.user}`,
        Env: ['TERM=xterm-256color', 'LANG=C.UTF-8'],
        Cmd: ['bash', '-l'],
      });
      const socket = await attach(this.endpoint, exec.Id, s.cols, s.rows);
      s.execId = exec.Id;
      s.socket = socket;
      s.error = null;
      s.chain = [s.root];
      s.users = [s.user];
      this.on.prompt();
      const decoder = new StringDecoder('utf8');
      socket.on('data', (d: Buffer) => this.emit(s, s.tap.feed(decoder.write(d))));
      socket.on('close', () => {
        s.socket = null;
        s.execId = null;
        if (s.closed) return;
        this.emit(s, `\r\n\x1b[2m[shell on ${s.root} closed — press any key for a new one]\x1b[0m\r\n`);
        s.chain = [s.root];
        s.users = [s.user];
        this.on.prompt();
      });
      socket.on('error', () => socket.destroy());
    } catch (err) {
      const msg = (err as Error).message;
      if (msg !== s.error)
        this.emit(s, `\r\n\x1b[31mCan't open a shell on ${s.root}: ${msg}\x1b[0m\r\n` +
          `\x1b[2mIs the machine running? Check with: netgame status. Retrying…\x1b[0m\r\n`);
      s.error = msg;
      setTimeout(() => void this.open(s), RETRY_MS).unref();
    } finally {
      s.starting = false;
    }
  }
}
