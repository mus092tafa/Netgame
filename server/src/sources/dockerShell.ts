// Terminal for Docker mode, built on `docker exec` (no PTY, so one command at a time).
//
// `ssh host` is special: we check the login works, then keep a real `ssh -N` running in the
// background so the SSH connection shows up on the map, and run the next commands on `host`.
// `exit` kills that background ssh, so the line fades out like a real logout.
import { execFile } from 'node:child_process';
import type { ShellInfo } from '../../../shared/protocol.ts';
import { isSshLogin, parseCommand } from '../commandLog.ts';
import type { Level } from '../level.ts';
import type { RunResult, ShellRunner } from './sim.ts';

const CMD_TIMEOUT_S = 8;

interface Hop {
  machine: string;
  user: string;
  tag?: string; // argv[0] of the background `ssh -N`, used to kill it on exit
}

export interface DockerExecResult {
  output: string;
  exitCode: number;
}

export function dockerExec(machine: string, user: string, script: string, detach = false): Promise<DockerExecResult> {
  const args = detach
    ? ['exec', '-d', '-u', user, machine, 'bash', '-c', script]
    : ['exec', '-u', user, machine, 'timeout', '-k', '1', String(CMD_TIMEOUT_S), 'bash', '-lc', `cd ~ 2>/dev/null; ${script}`];
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: (CMD_TIMEOUT_S + 4) * 1000, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ output: `${stdout}${stderr}`, exitCode: code });
    });
  });
}

const HELP = `Docker mode — every command really runs inside the container.
  ssh [user@]host                 hop into another machine (exit to come back)
  curl http://host[:port]/        fetch a web page
  ping -c 2 host                  ICMP echo — no ports involved
  nc -zv host port                check if a port is open
  psql -h db-01 -U app -c 'select 1'   one SQL query (interactive psql isn't supported here)
  sudo systemctl start|stop|status nginx|sshd|postgres
  ss -tunap                       this machine's sockets (what the map reads!)
Commands are stopped after ${CMD_TIMEOUT_S}s.
`;

export class DockerShell implements ShellRunner {
  private tabs = new Map<string, Hop[]>();
  private seq = 0;

  constructor(
    private level: Level,
    /** Name/IP → container id, regardless of reachability (used after a successful ssh). */
    private lookup: (name: string) => string | null,
    /** Edge id of the live SSH connection between two machines, if polling has seen it. */
    private findEdge: (client: string, server: string, port: number) => string | null,
  ) {
    for (const m of level.machines) if (m.terminal) this.tabs.set(m.id, [{ machine: m.id, user: m.user }]);
  }

  private userOf(machine: string) {
    return this.level.machines.find((m) => m.id === machine)?.user ?? 'root';
  }

  shells(): ShellInfo[] {
    return [...this.tabs.entries()].map(([tab, hops]) => {
      const top = hops[hops.length - 1];
      return {
        tab,
        root: hops[0].machine,
        chain: hops.map((h) => h.machine),
        hopEdges: hops.slice(1).map((h, i) => this.findEdge(hops[i].machine, h.machine, 22)),
        prompt: `${top.user}@${top.machine}:~$ `,
      };
    });
  }

  private queues = new Map<string, Promise<unknown>>();

  /** Commands in one tab run one after another, like a real shell. */
  run(tab: string, line: string): Promise<RunResult> {
    const prev = this.queues.get(tab) ?? Promise.resolve();
    const next = prev.then(() => this.runNow(tab, line));
    this.queues.set(tab, next.catch(() => undefined));
    return next;
  }

  private async runNow(tab: string, line: string): Promise<RunResult> {
    const hops = this.tabs.get(tab);
    if (!hops) return { machine: tab, output: 'no such terminal\n', exitCode: 1, log: false };
    const top = hops[hops.length - 1];
    const here = top.machine;
    const trimmed = line.trim();
    const local = (output: string, exitCode = 0): RunResult => ({ machine: here, output, exitCode, log: false });

    if (!trimmed) return local('');
    if (trimmed === 'help') return local(HELP);
    if (trimmed === 'clear') return local('\x1bclear');

    if (trimmed === 'exit' || trimmed === 'logout') {
      if (hops.length === 1) return local('This is your own machine — there is nowhere to exit to.\n');
      hops.pop();
      const back = hops[hops.length - 1];
      if (top.tag) await dockerExec(back.machine, back.user, `pkill -f '^${top.tag}' || true`);
      return local(`logout\nConnection to ${here} closed.\n`);
    }

    const parsed = parseCommand(trimmed);
    const sshArgs = trimmed.replace(/^ssh\s+/, '');
    // `ssh host` with no remote command → hop. (`ssh host cmd` just runs below like anything else.)
    if (parsed?.tool === 'ssh' && isSshLogin(trimmed)) {
      const check = await dockerExec(here, top.user, `ssh -o BatchMode=yes -o ConnectTimeout=5 ${sshArgs} true`);
      if (check.exitCode !== 0) return { machine: here, output: check.output, exitCode: check.exitCode, log: true };
      const target = this.lookup(parsed.host);
      if (!target) return local(`(connected, but ${parsed.host} isn't a machine in this level)\n`, 1);
      const tag = `netgame-hop-${++this.seq}`;
      await dockerExec(here, top.user, `exec -a ${tag} ssh -N -o BatchMode=yes -o ServerAliveInterval=15 ${sshArgs}`, true);
      const user = trimmed.match(/(\S+)@/)?.[1] ?? 'dev';
      hops.push({ machine: target, user: target === here ? top.user : user, tag });
      return { machine: here, output: `Welcome to ${target} (Debian GNU/Linux 12)\n`, exitCode: 0, log: true };
    }

    if (parsed?.tool === 'psql' && !/\s-c\s/.test(` ${trimmed} `))
      return local(`Interactive psql isn't supported in the Docker terminal. Add a query, e.g.\n  ${trimmed} -c 'select 1'\n`, 1);

    const res = await dockerExec(here, top.user, trimmed);
    let output = res.output;
    if (res.exitCode === 124) output += `\n(stopped after ${CMD_TIMEOUT_S}s: Connection timed out, no answer)\n`;
    if (res.exitCode === 127 && /command not found/.test(output)) return local(output, 127);
    return { machine: here, output, exitCode: res.exitCode, log: true };
  }

  /** Kill background hops (server shutdown). */
  async closeAll() {
    for (const hops of this.tabs.values()) {
      for (let i = hops.length - 1; i > 0; i--) {
        const prev = hops[i - 1];
        if (hops[i].tag) await dockerExec(prev.machine, prev.user, `pkill -f '^${hops[i].tag}' || true`);
      }
      hops.splice(1);
    }
  }
}
