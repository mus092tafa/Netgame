// Failed attempts and one-shot connections don't stay in `ss` long enough to be polled,
// so we derive them from the terminal's command log.
import type { FailReason, MapEdge, MapEvent } from '../../shared/protocol.ts';
import { lookupService } from '../../shared/services.ts';

export interface ParsedCommand {
  tool: 'ssh' | 'curl' | 'wget' | 'nc' | 'telnet' | 'ping' | 'psql' | 'mysql' | 'redis-cli';
  host: string;
  port?: number; // undefined for ping
  /** One-shot tools whose success won't be visible to polling. */
  oneShot: boolean;
}

const URL_TOOLS = new Set(['curl', 'wget']);

/** Splits a shell line into words, honoring simple quotes. Only the first command of a pipeline is used. */
function words(line: string): string[] {
  const first = line.split(/\s*(?:\|\||&&|\||;)\s*/)[0] ?? '';
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(first))) out.push(m[1] ?? m[2] ?? m[3]);
  // Strip `sudo` and env assignments.
  while (out.length && (out[0] === 'sudo' || /^\w+=/.test(out[0]))) out.shift();
  return out;
}

/** Options that consume the next word, per tool (so we don't mistake their value for the host). */
const OPTS_WITH_VALUE: Record<string, string> = {
  ssh: 'bcDEeFIiJLlmOopQRSWw',
  curl: 'ABbcDdEeFHhKmoQrTUuXxYyz',
  wget: 'OoPaeTtUw',
  nc: 'IOPpqsTVwXx',
  ping: 'cIiltswWQ',
  telnet: 'elnbS',
  psql: 'cdfhpUvL',
  mysql: 'hPpuDe',
  'redis-cli': 'hpanu',
};

function positional(args: string[], tool: string): { pos: string[]; flags: Map<string, string> } {
  const withValue = OPTS_WITH_VALUE[tool] ?? '';
  const pos: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) flags.set(k, v);
      else flags.set(k, '');
      continue;
    }
    if (a.startsWith('-') && a.length > 1) {
      const letters = a.slice(1);
      for (let j = 0; j < letters.length; j++) {
        const c = letters[j];
        if (withValue.includes(c)) {
          const val = letters.slice(j + 1) || args[++i] || '';
          flags.set(c, val);
          break;
        }
        flags.set(c, '');
      }
      continue;
    }
    pos.push(a);
  }
  return { pos, flags };
}

/** True for `ssh [opts] host` with no remote command (an interactive login). */
export function isSshLogin(line: string): boolean {
  const w = words(line.trim());
  if (w[0] !== 'ssh') return false;
  return positional(w.slice(1), 'ssh').pos.length === 1;
}

export function parseCommand(line: string): ParsedCommand | null {
  const w = words(line.trim());
  if (!w.length) return null;
  const tool = w[0].split('/').pop()!;
  const { pos, flags } = positional(w.slice(1), tool);

  switch (tool) {
    case 'ssh': {
      if (!pos[0]) return null;
      const host = pos[0].includes('@') ? pos[0].split('@').pop()! : pos[0];
      return { tool, host, port: Number(flags.get('p') ?? 22), oneShot: false };
    }
    case 'curl':
    case 'wget': {
      const target = pos.find((p) => !p.startsWith('-'));
      if (!target) return null;
      let url: URL;
      try {
        url = new URL(/^[a-z]+:\/\//i.test(target) ? target : `http://${target}`);
      } catch {
        return null;
      }
      const scheme = url.protocol.replace(':', '');
      const port = url.port ? Number(url.port) : scheme === 'https' ? 443 : 80;
      return { tool, host: url.hostname.replace(/^\[|\]$/g, ''), port, oneShot: true };
    }
    case 'nc':
    case 'ncat':
    case 'netcat':
    case 'telnet': {
      if (!pos[0]) return null;
      const port = Number(pos[1] ?? (tool === 'telnet' ? 23 : NaN));
      if (!Number.isFinite(port)) return null;
      const t = tool === 'telnet' ? 'telnet' : 'nc';
      // `nc -z` is a port check: open+close instantly.
      // A real telnet session would also be polled; the map dedupes the two.
      return { tool: t, host: pos[0], port, oneShot: t === 'telnet' || flags.has('z') };
    }
    case 'ping': {
      if (!pos[0]) return null;
      return { tool, host: pos[0], oneShot: true };
    }
    case 'psql':
    case 'mysql':
    case 'redis-cli': {
      const host = flags.get('h');
      if (!host) return null;
      const defPort = tool === 'psql' ? 5432 : tool === 'mysql' ? 3306 : 6379;
      const portFlag = tool === 'mysql' ? flags.get('P') : flags.get('p');
      // With a query on the command line the client connects, runs it and disconnects at once.
      const oneShot = tool === 'psql' ? flags.has('c') : tool === 'mysql' ? flags.has('e') : pos.length > 0;
      return { tool, host, port: Number(portFlag || defPort), oneShot };
    }
    default:
      if (URL_TOOLS.has(tool)) return null;
      return null;
  }
}

/** Figures out why a connection command failed from its output. null = it didn't fail. */
export function failureReason(output: string, exitCode: number): FailReason | null {
  const o = output.toLowerCase();
  if (/could not resolve|name or service not known|unknown host|temporary failure in name resolution|bad address|could not translate host name|nodename nor servname|not known/.test(o))
    return 'unknown-host';
  // curl ≤7.x says "Couldn't connect to server" (exit 7) when the port is closed.
  if (/connection refused|refused|couldn't connect to server/.test(o)) return 'refused';
  if (/no route to host|network is unreachable|host unreachable|destination host unreachable/.test(o)) return 'no-route';
  if (/timed out|timeout|100% packet loss/.test(o)) return 'timeout';
  if (exitCode !== 0 && exitCode !== 130) return null; // failed for some other reason (auth, 404...) — connection itself worked
  return null;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export interface LogContext {
  /** hostname or IP → machine id, as seen from `machine` (null when it can't be resolved there). */
  resolve(name: string, fromMachine: string): string | null;
  /** Any known machine owning that name/IP, regardless of reachability. */
  lookupAnywhere(name: string): string | null;
  ipOf(machine: string, towards: string): string;
  dnsServer: string | null;
  newId(): string;
  now(): number;
}

export interface LogResult {
  events: MapEvent[];
  oneShotEdges: MapEdge[];
}

export function processCommandLog(
  entry: { machine: string; line: string; output: string; exitCode: number },
  ctx: LogContext,
): LogResult {
  const result: LogResult = { events: [], oneShotEdges: [] };
  const cmd = parseCommand(entry.line);
  if (!cmd) return result;
  const now = ctx.now();
  // `curl -s` hides the error text; its exit code still says what happened.
  const curlCodes: Record<number, FailReason> = { 6: 'unknown-host', 7: 'refused', 28: 'timeout' };
  const reason =
    failureReason(entry.output, entry.exitCode) ?? (cmd.tool === 'curl' ? curlCodes[entry.exitCode] ?? null : null);
  const isName = !IPV4.test(cmd.host) && !cmd.host.includes(':');

  // DNS lookup flash (only when the level has a DNS server and a name was typed).
  if (isName && ctx.dnsServer && cmd.host !== 'localhost') {
    result.events.push({
      kind: 'dns',
      id: ctx.newId(),
      at: now,
      from: entry.machine,
      to: ctx.dnsServer,
      name: cmd.host,
      ok: reason !== 'unknown-host',
    });
  }

  const target = ctx.resolve(cmd.host, entry.machine) ?? ctx.lookupAnywhere(cmd.host);

  if (cmd.tool === 'ping') {
    if (reason === 'unknown-host' || reason === 'no-route' || !target) {
      result.events.push({
        kind: 'failed', id: ctx.newId(), at: now, from: entry.machine,
        to: reason === 'unknown-host' ? null : target, target: cmd.host,
        category: 'icmp', reason: reason ?? 'unknown-host', command: entry.line,
      });
    } else {
      result.events.push({ kind: 'ping', id: ctx.newId(), at: now, from: entry.machine, to: target, ok: reason == null, command: entry.line });
    }
    return result;
  }

  const port = cmd.port!;
  const svc = lookupService(port);
  if (reason) {
    result.events.push({
      kind: 'failed', id: ctx.newId(), at: now, from: entry.machine,
      to: reason === 'unknown-host' ? null : target, target: cmd.host, port,
      service: svc.name, category: svc.category, reason, command: entry.line,
    });
    return result;
  }

  if (cmd.oneShot && target) {
    const clientIp = ctx.ipOf(entry.machine, target);
    const serverIp = ctx.ipOf(target, entry.machine);
    result.oneShotEdges.push({
      id: `oneshot:${ctx.newId()}`,
      client: { machine: entry.machine, ip: clientIp, port: 0 },
      server: { machine: target, ip: serverIp, port },
      transport: 'tcp',
      service: svc.name,
      category: svc.category,
      state: 'CLOSED',
      openedAt: now,
      oneShot: true,
      clientProcess: cmd.tool,
    });
  }
  return result;
}
