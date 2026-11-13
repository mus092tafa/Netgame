// Simulator: a tiny fake network so the map can be played without Docker.
// It produces real `ss -tunapi` text (fed through the same parser as Docker mode)
// and realistic tool output (fed through the same command-log parser).
import type { ShellInfo, Zone } from '../../../shared/protocol.ts';
import { lookupService } from '../../../shared/services.ts';
import { parseCommand } from '../commandLog.ts';
import { edgeId } from '../correlate.ts';
import type { Level, LevelMachine } from '../level.ts';
import type { BareNode, MachineSource } from './source.ts';

interface SimService {
  name: string;
  port: number;
  transport: 'tcp' | 'udp';
  running: boolean;
}

interface SimMachine {
  def: LevelMachine;
  running: boolean;
  services: SimService[];
}

interface SimConn {
  id: number;
  client: string;
  clientIp: string;
  clientPort: number;
  clientProc: string;
  server: string;
  serverIp: string;
  serverPort: number;
  serverProc: string;
  bytesUp: number;
  bytesDown: number;
}

interface Hop {
  machine: string;
  user: string;
  conn: SimConn | null; // connection that brought us here (null for the root)
  app?: { kind: 'psql'; conn: SimConn; db: string; user: string };
}

interface Tab {
  id: string;
  hops: Hop[];
}

export interface RunResult {
  machine: string; // machine the command ran on
  output: string;
  exitCode: number;
  /** false for commands that shouldn't reach the command log (shell builtins, sim-only). */
  log: boolean;
}

/** Something that runs the player's terminal commands (simulator or docker exec). */
export interface ShellRunner {
  shells(): ShellInfo[];
  run(tab: string, line: string): RunResult | Promise<RunResult>;
}

type Reach =
  | { ok: true; target: string; ip: string }
  | { ok: false; reason: 'unknown-host' | 'no-route' | 'timeout' | 'refused'; target?: string; ip?: string };

const HELP = `Commands you can try:
  ssh [user@]host [-p port]     open a remote shell (exit to come back)
  curl http://host[:port]/      fetch a web page (one quick connection)
  ping [-c n] host              ICMP echo — no ports involved
  nc -zv host port              check if a port is open
  psql -h host -U user          connect to PostgreSQL (\\q to quit)
  systemctl start|stop|status <service>   e.g. nginx, sshd, postgres
  ss -tunap                     list this machine's sockets (what the map reads!)
  ip a | hostname | whoami | clear | exit
`;

export class SimSource implements MachineSource, ShellRunner {
  readonly mode = 'sim' as const;
  private machines = new Map<string, SimMachine>();
  private conns: SimConn[] = [];
  private tabs = new Map<string, Tab>();
  private nextConn = 1;
  private usedPorts = new Set<number>();

  constructor(private level: Level) {
    for (const m of level.machines) {
      this.machines.set(m.id, {
        def: m,
        running: true,
        services: (m.services ?? []).map((s) => ({
          name: s.name,
          port: s.port,
          transport: s.transport ?? 'tcp',
          running: s.running ?? true,
        })),
      });
      if (m.terminal) this.tabs.set(m.id, { id: m.id, hops: [{ machine: m.id, user: m.user, conn: null }] });
    }
  }

  // ---------- MachineSource ----------

  async topology() {
    const zones: Zone[] = this.level.networks.map((n) => ({ id: n.id, name: n.name ?? n.id, subnet: n.subnet }));
    const nodes: BareNode[] = [...this.machines.values()].map((m) => ({
      id: m.def.id,
      hostname: m.def.id,
      kind: m.def.kind,
      status: m.running ? 'running' : 'stopped',
      user: this.loggedInUser(m.def.id),
      ifaces: Object.entries(m.def.networks).map(([network, ip]) => ({ network, ip })),
    }));
    return { zones, nodes };
  }

  async sockets(machine: string): Promise<string> {
    return this.ssText(machine, false);
  }

  // ---------- shells ----------

  shells(): ShellInfo[] {
    return [...this.tabs.values()].map((t) => ({
      tab: t.id,
      root: t.hops[0].machine,
      chain: t.hops.map((h) => h.machine),
      hopEdges: t.hops.slice(1).map((h) => (h.conn ? this.connEdgeId(h.conn) : null)),
      prompt: this.prompt(t),
    }));
  }

  private connEdgeId(c: SimConn) {
    return edgeId('tcp', c.clientIp, c.clientPort, c.serverIp, c.serverPort);
  }

  private prompt(t: Tab): string {
    const top = t.hops[t.hops.length - 1];
    if (top.app) return `${top.app.db}=> `;
    return `${top.user}@${top.machine}:~$ `;
  }

  private loggedInUser(machine: string): string {
    for (const t of this.tabs.values()) {
      const hop = [...t.hops].reverse().find((h) => h.machine === machine);
      if (hop) return hop.user;
    }
    return this.machines.get(machine)?.def.user ?? 'root';
  }

  // ---------- network rules ----------

  private ipsOf(id: string) {
    return Object.entries(this.machines.get(id)!.def.networks);
  }

  private shared(a: string, b: string) {
    const nb = this.machines.get(b)!.def.networks;
    return this.ipsOf(a).filter(([net]) => net in nb).map(([net]) => net);
  }

  private ipOn(machine: string, towards: string): string {
    const shared = this.shared(machine, towards);
    const ips = this.ipsOf(machine);
    return (ips.find(([net]) => shared.includes(net)) ?? ips[0])[1];
  }

  private reach(from: string, host: string, port: number | null): Reach {
    let target: string | undefined;
    let viaIp: string | undefined;
    if (host === 'localhost' || host === '127.0.0.1') target = from;
    else if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      viaIp = host;
      target = [...this.machines.keys()].find((id) => this.ipsOf(id).some(([, ip]) => ip === host));
      if (!target) return { ok: false, reason: 'no-route', ip: host };
    } else {
      target = this.machines.has(host) ? host : undefined;
      // Like Docker's DNS: names only resolve inside a shared network.
      if (!target || (target !== from && !this.shared(from, target).length)) return { ok: false, reason: 'unknown-host' };
    }
    const ip = viaIp ?? (target === from ? '127.0.0.1' : this.ipOn(target, from));
    if (target !== from && !this.shared(from, target).length) return { ok: false, reason: 'no-route', target, ip };
    const m = this.machines.get(target)!;
    if (!m.running) return { ok: false, reason: 'no-route', target, ip };
    if (port == null) return { ok: true, target, ip };
    if (target !== from && m.def.firewall?.drop?.includes(port)) return { ok: false, reason: 'timeout', target, ip };
    if (!m.services.some((s) => s.running && s.port === port && s.transport === 'tcp'))
      return { ok: false, reason: 'refused', target, ip };
    return { ok: true, target, ip };
  }

  private ephemeral(): number {
    let p: number;
    do p = 32768 + Math.floor(Math.random() * 28000);
    while (this.usedPorts.has(p));
    this.usedPorts.add(p);
    return p;
  }

  private open(from: string, to: string, toIp: string, port: number, clientProc: string): SimConn {
    const svc = this.machines.get(to)!.services.find((s) => s.port === port)!;
    const c: SimConn = {
      id: this.nextConn++,
      client: from,
      clientIp: from === to ? '127.0.0.1' : this.ipOn(from, to),
      clientPort: this.ephemeral(),
      clientProc,
      server: to,
      serverIp: toIp,
      serverPort: port,
      serverProc: svc.name,
      bytesUp: 300 + Math.floor(Math.random() * 400),
      bytesDown: 800 + Math.floor(Math.random() * 600),
    };
    this.conns.push(c);
    return c;
  }

  private close(c: SimConn) {
    this.conns = this.conns.filter((x) => x !== c);
    this.usedPorts.delete(c.clientPort);
  }

  // ---------- ss output ----------

  private ssText(machine: string, header: boolean, listenOnly = false): string {
    const m = this.machines.get(machine);
    if (!m || !m.running) return '';
    const lines: string[] = [];
    if (header)
      lines.push('Netid State  Recv-Q Send-Q Local Address:Port   Peer Address:Port  Process');
    // Docker's embedded DNS listener is always there (and gets filtered as loopback).
    lines.push(`tcp   LISTEN 0      4096   127.0.0.11:${40000 + machine.length}  0.0.0.0:*`);
    let pid = 10;
    for (const s of m.services) {
      if (!s.running) continue;
      const state = s.transport === 'udp' ? 'UNCONN' : 'LISTEN';
      lines.push(`${s.transport}   ${state} 0      128    0.0.0.0:${s.port}  0.0.0.0:*  users:(("${s.name}",pid=${pid++},fd=3))`);
    }
    if (!listenOnly) {
      for (const c of this.conns) {
        if (c.client === machine) {
          lines.push(`tcp   ESTAB  0      0      ${c.clientIp}:${c.clientPort}  ${c.serverIp}:${c.serverPort}  users:(("${c.clientProc}",pid=${100 + c.id},fd=3))`);
          lines.push(`\t cubic wscale:7,7 rto:204 bytes_sent:${c.bytesUp} bytes_acked:${c.bytesUp} bytes_received:${c.bytesDown}`);
        }
        if (c.server === machine) {
          lines.push(`tcp   ESTAB  0      0      ${c.serverIp}:${c.serverPort}  ${c.clientIp}:${c.clientPort}  users:(("${c.serverProc}",pid=${200 + c.id},fd=4))`);
          lines.push(`\t cubic wscale:7,7 rto:204 bytes_sent:${c.bytesDown} bytes_acked:${c.bytesDown} bytes_received:${c.bytesUp}`);
        }
      }
    }
    return lines.join('\n') + '\n';
  }

  /** A bit of background chatter so live connections show moving dots. */
  tickTraffic() {
    for (const c of this.conns) {
      c.bytesUp += 20 + Math.floor(Math.random() * 60);
      c.bytesDown += 40 + Math.floor(Math.random() * 100);
    }
  }

  private addTraffic(conn: SimConn | null, up: number, down: number) {
    if (!conn) return;
    conn.bytesUp += up;
    conn.bytesDown += down;
  }

  // ---------- commands ----------

  run(tabId: string, line: string): RunResult {
    const tab = this.tabs.get(tabId);
    if (!tab) return { machine: tabId, output: 'no such terminal\n', exitCode: 1, log: false };
    const top = tab.hops[tab.hops.length - 1];
    const here = top.machine;
    const res = (output: string, exitCode = 0, log = false): RunResult => ({ machine: here, output, exitCode, log });
    const trimmed = line.trim();
    // Every keystroke over ssh travels through all the hops.
    for (const h of tab.hops) this.addTraffic(h.conn, trimmed.length + 40, 120);

    if (top.app?.kind === 'psql') return this.runPsql(tab, top, trimmed);
    if (!trimmed) return res('');

    const [cmd, ...args] = trimmed.split(/\s+/);
    switch (cmd) {
      case 'help':
        return res(HELP);
      case 'clear':
        return res('\x1bclear');
      case 'whoami':
        return res(`${top.user}\n`);
      case 'hostname':
        if (args[0] === '-I') return res(this.ipsOf(here).map(([, ip]) => ip).join(' ') + '\n');
        return res(`${here}\n`);
      case 'ip':
        return res(this.ipAddr(here));
      case 'exit':
      case 'logout': {
        if (tab.hops.length === 1) return res('This is your own machine — there is nowhere to exit to.\n');
        tab.hops.pop();
        if (top.conn) this.close(top.conn);
        return res(`logout\nConnection to ${top.machine} closed.\n`);
      }
      case 'ss':
      case 'netstat': {
        const listenOnly = args.some((a) => /^-\w*l/.test(a));
        return res(this.ssText(here, true, listenOnly));
      }
      case 'systemctl':
      case 'service':
        return this.runService(here, cmd === 'service' ? [args[1], args[0]] : args, res);
      case 'ssh':
        return this.runSsh(tab, here, trimmed);
      case 'curl':
      case 'wget':
        return this.runCurl(here, trimmed, cmd);
      case 'ping':
        return this.runPing(here, trimmed);
      case 'nc':
      case 'ncat':
      case 'netcat':
      case 'telnet':
        return this.runNc(here, trimmed, cmd);
      case 'psql':
        return this.runPsqlConnect(tab, here, trimmed);
      default:
        return res(`${cmd}: command not found (type "help")\n`, 127);
    }
  }

  private ipAddr(here: string) {
    let out = '1: lo: <LOOPBACK,UP> mtu 65536\n    inet 127.0.0.1/8 scope host lo\n';
    this.ipsOf(here).forEach(([net, ip], i) => {
      const prefix = this.level.networks.find((n) => n.id === net)?.subnet.split('/')[1] ?? '24';
      out += `${i + 2}: eth${i}: <BROADCAST,UP> mtu 1500   # network "${net}"\n    inet ${ip}/${prefix} scope global eth${i}\n`;
    });
    return out;
  }

  private runService(here: string, args: string[], res: (o: string, c?: number, l?: boolean) => RunResult) {
    const [action, name] = args;
    const m = this.machines.get(here)!;
    const svc = m.services.find((s) => s.name === name || `${s.name}.service` === name);
    if (!action || !name) return res('usage: systemctl start|stop|restart|status <service>\n', 1);
    if (!svc) return res(`Failed to ${action} ${name}.service: Unit ${name}.service not found.\n`, 5);
    switch (action) {
      case 'start':
      case 'restart':
        svc.running = true;
        return res('');
      case 'stop':
        svc.running = false;
        for (const c of this.conns.filter((c) => c.server === here && c.serverPort === svc.port)) {
          if (svc.name !== 'sshd') this.close(c); // like real sshd, existing sessions survive a stop
        }
        return res('');
      case 'status':
        return res(
          `● ${svc.name}.service\n     Active: ${svc.running ? 'active (running)' : 'inactive (dead)'}\n     Listen: ${svc.port}/${svc.transport}\n`,
          svc.running ? 0 : 3,
        );
      default:
        return res(`Unknown command verb ${action}.\n`, 1);
    }
  }

  private runSsh(tab: Tab, here: string, line: string): RunResult {
    const p = parseCommand(line);
    if (!p) return { machine: here, output: 'usage: ssh [user@]host [-p port]\n', exitCode: 255, log: false };
    const userPart = line.match(/(\S+)@/)?.[1];
    const r = this.reach(here, p.host, p.port!);
    const fail = (msg: string): RunResult => ({ machine: here, output: msg, exitCode: 255, log: true });
    if (!r.ok) {
      switch (r.reason) {
        case 'unknown-host':
          return fail(`ssh: Could not resolve hostname ${p.host}: Name or service not known\n`);
        case 'no-route':
          return fail(`ssh: connect to host ${p.host} port ${p.port}: No route to host\n`);
        case 'timeout':
          return fail(`ssh: connect to host ${p.host} port ${p.port}: Connection timed out\n`);
        case 'refused':
          return fail(`ssh: connect to host ${p.host} port ${p.port}: Connection refused\n`);
      }
    }
    const user = userPart ?? tab.hops[tab.hops.length - 1].user;
    const conn = this.open(here, r.target, r.ip, p.port!, 'ssh');
    tab.hops.push({ machine: r.target, user, conn });
    const target = this.machines.get(r.target)!;
    return {
      machine: here,
      output: `Welcome to ${r.target} (Debian GNU/Linux)\n${target.def.password ? '' : ''}Last login: just now from ${conn.clientIp}\n`,
      exitCode: 0,
      log: true,
    };
  }

  private runCurl(here: string, line: string, tool: string): RunResult {
    const p = parseCommand(line);
    if (!p) return { machine: here, output: `${tool}: try '${tool} http://web-01/'\n`, exitCode: 2, log: false };
    const r = this.reach(here, p.host, p.port!);
    const out = (o: string, code: number): RunResult => ({ machine: here, output: o, exitCode: code, log: true });
    const t = Math.floor(Math.random() * 4);
    if (!r.ok) {
      if (tool === 'wget') {
        const msg = { 'unknown-host': `unable to resolve host address '${p.host}'`, 'no-route': 'No route to host.', timeout: 'Connection timed out.', refused: 'Connection refused.' }[r.reason];
        return out(`Connecting to ${p.host}:${p.port}... failed: ${msg}\n`, 4);
      }
      switch (r.reason) {
        case 'unknown-host':
          return out(`curl: (6) Could not resolve host: ${p.host}\n`, 6);
        case 'no-route':
          return out(`curl: (7) Failed to connect to ${p.host} port ${p.port} after ${t} ms: No route to host\n`, 7);
        case 'timeout':
          return out(`curl: (28) Failed to connect to ${p.host} port ${p.port} after 5001 ms: Timeout was reached\n`, 28);
        case 'refused':
          return out(`curl: (7) Failed to connect to ${p.host} port ${p.port} after ${t} ms: Connection refused\n`, 7);
      }
    }
    const svc = this.machines.get(r.target)!.services.find((s) => s.port === p.port)!;
    if (!['nginx', 'apache2', 'httpd', 'node'].includes(svc.name))
      return out(`curl: (52) Empty reply from server\n`, 52); // connected, but it doesn't speak HTTP
    const body = `<!doctype html>\n<html><body><h1>Hello from ${r.target}</h1><p>Served by ${svc.name} on port ${p.port}.</p></body></html>\n`;
    if (tool === 'wget') return out(`Connecting to ${p.host} (${r.ip}):${p.port}... connected.\nHTTP request sent, awaiting response... 200 OK\nSaving to: 'index.html'\n`, 0);
    return out(body, 0);
  }

  private runPing(here: string, line: string): RunResult {
    const p = parseCommand(line);
    if (!p) return { machine: here, output: 'ping: usage error: Destination address required\n', exitCode: 2, log: false };
    const count = Math.min(Number(line.match(/-c\s*(\d+)/)?.[1] ?? 3), 10);
    const r = this.reach(here, p.host, null);
    const out = (o: string, code: number): RunResult => ({ machine: here, output: o, exitCode: code, log: true });
    if (!r.ok && r.reason === 'unknown-host') return out(`ping: ${p.host}: Name or service not known\n`, 2);
    const ip = r.ip ?? p.host;
    let o = `PING ${p.host} (${ip}) 56(84) bytes of data.\n`;
    if (!r.ok) {
      const myIp = this.ipsOf(here)[0][1];
      for (let i = 1; i <= count; i++) o += `From ${myIp} icmp_seq=${i} Destination Host Unreachable\n`;
      o += `\n--- ${p.host} ping statistics ---\n${count} packets transmitted, 0 received, +${count} errors, 100% packet loss\n`;
      return out(o, 1);
    }
    for (let i = 1; i <= count; i++) o += `64 bytes from ${ip}: icmp_seq=${i} ttl=64 time=0.0${4 + Math.floor(Math.random() * 6)} ms\n`;
    o += `\n--- ${p.host} ping statistics ---\n${count} packets transmitted, ${count} received, 0% packet loss\n`;
    return out(o, 0);
  }

  private runNc(here: string, line: string, tool: string): RunResult {
    const p = parseCommand(line);
    if (!p) return { machine: here, output: `usage: ${tool === 'telnet' ? 'telnet host port' : 'nc -zv host port'}\n`, exitCode: 1, log: false };
    const r = this.reach(here, p.host, p.port!);
    const out = (o: string, code: number): RunResult => ({ machine: here, output: o, exitCode: code, log: true });
    if (tool === 'telnet') {
      if (!r.ok) {
        if (r.reason === 'unknown-host') return out(`telnet: could not resolve ${p.host}/${p.port}: Name or service not known\n`, 1);
        const why = { 'no-route': 'No route to host', timeout: 'Connection timed out', refused: 'Connection refused' }[r.reason];
        return out(`Trying ${r.ip}...\ntelnet: Unable to connect to remote host: ${why}\n`, 1);
      }
      return out(`Trying ${r.ip}...\nConnected to ${p.host}.\nEscape character is '^]'.\nConnection closed by foreign host.\n`, 0);
    }
    if (!/\s-\w*z/.test(line))
      return { machine: here, output: 'Interactive nc isn\'t simulated — use "nc -zv host port" to test a port.\n', exitCode: 1, log: false };
    if (!r.ok) {
      if (r.reason === 'unknown-host') return out(`nc: getaddrinfo for host "${p.host}" port ${p.port}: Name or service not known\n`, 1);
      const why = { 'no-route': 'No route to host', timeout: 'Connection timed out', refused: 'Connection refused' }[r.reason];
      return out(`nc: connect to ${p.host} (${r.ip}) port ${p.port} (tcp) failed: ${why}\n`, 1);
    }
    const svc = lookupService(p.port!).name.toLowerCase();
    return out(`Connection to ${p.host} (${r.ip}) ${p.port} port [tcp/${svc}] succeeded!\n`, 0);
  }

  private runPsqlConnect(tab: Tab, here: string, line: string): RunResult {
    const p = parseCommand(line);
    if (!p) return { machine: here, output: 'psql: error: give a host with -h, e.g. psql -h db-01 -U app\n', exitCode: 2, log: false };
    const r = this.reach(here, p.host, p.port!);
    const out = (o: string, code: number): RunResult => ({ machine: here, output: o, exitCode: code, log: true });
    if (!r.ok) {
      if (r.reason === 'unknown-host')
        return out(`psql: error: could not translate host name "${p.host}" to address: Name or service not known\n`, 2);
      const why = { 'no-route': 'No route to host', timeout: 'Connection timed out', refused: 'Connection refused' }[r.reason];
      return out(`psql: error: connection to server at "${p.host}" (${r.ip}), port ${p.port} failed: ${why}\n`, 2);
    }
    const user = line.match(/-U\s*(\S+)/)?.[1] ?? tab.hops[tab.hops.length - 1].user;
    const db = line.match(/-d\s*(\S+)/)?.[1] ?? user;
    const conn = this.open(here, r.target, r.ip, p.port!, 'psql');
    const top = tab.hops[tab.hops.length - 1];
    top.app = { kind: 'psql', conn, db, user };
    return out(`psql (16.4)\nType "help" for help. \\q to quit.\n\n`, 0);
  }

  private runPsql(tab: Tab, top: Hop, line: string): RunResult {
    const app = top.app!;
    const res = (o: string): RunResult => ({ machine: top.machine, output: o, exitCode: 0, log: false });
    if (line === '\\q' || line === 'exit' || line === 'quit') {
      this.close(app.conn);
      top.app = undefined;
      return res('');
    }
    if (!line) return res('');
    this.addTraffic(app.conn, line.length + 60, 400);
    if (/^select/i.test(line)) return res(' ?column? \n----------\n        1\n(1 row)\n\n');
    if (line === '\\conninfo')
      return res(`You are connected to database "${app.db}" as user "${app.user}" on host "${app.conn.server}" (address "${app.conn.serverIp}") at port "${app.conn.serverPort}".\n`);
    if (line === 'help') return res('Try: SELECT 1;  \\conninfo  \\q\n');
    return res(`ERROR:  syntax error at or near "${line.split(/\s+/)[0]}"\n`);
  }
}
