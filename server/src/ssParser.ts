// Parses the output of `ss -tunapi` (with or without -H) into socket entries.

export interface SsAddr {
  ip: string; // normalized: no brackets, no ::ffff:, no %iface; '*' for wildcard
  port: number | null; // null for '*'
}

export interface SsEntry {
  transport: 'tcp' | 'udp';
  state: string; // LISTEN, ESTAB, UNCONN, SYN-SENT, TIME-WAIT...
  local: SsAddr;
  peer: SsAddr;
  process?: string;
  pid?: number;
  bytesSent?: number;
  bytesReceived?: number;
}

export function parseAddr(raw: string): SsAddr {
  const idx = raw.lastIndexOf(':');
  if (idx < 0) return { ip: raw, port: null };
  let host = raw.slice(0, idx);
  const portStr = raw.slice(idx + 1);
  host = host.replace(/^\[/, '').replace(/\]$/, '');
  host = host.replace(/%[^%]*$/, ''); // 10.0.0.1%eth0
  host = host.replace(/^::ffff:/i, '');
  if (host === '' || host === '0.0.0.0' || host === '::' || host === '*') host = '*';
  const port = portStr === '*' ? null : Number(portStr);
  return { ip: host, port: Number.isFinite(port as number) ? (port as number) : null };
}

const STATE_ALIASES: Record<string, string> = { ESTABLISHED: 'ESTAB' };

export function parseSs(output: string): SsEntry[] {
  const entries: SsEntry[] = [];
  for (const rawLine of output.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    // `ss -i` puts TCP info on an indented continuation line.
    if (/^\s/.test(rawLine)) {
      const last = entries[entries.length - 1];
      if (!last) continue;
      const sent = /bytes_(?:sent|acked):(\d+)/.exec(rawLine);
      const recv = /bytes_received:(\d+)/.exec(rawLine);
      if (sent) last.bytesSent = Number(sent[1]);
      if (recv) last.bytesReceived = Number(recv[1]);
      continue;
    }
    const cols = rawLine.trim().split(/\s+/);
    if (cols[0] === 'Netid' || cols[0] === 'State') continue; // header
    const transport = cols[0];
    if (transport !== 'tcp' && transport !== 'udp') continue;
    if (cols.length < 6) continue;
    const state = STATE_ALIASES[cols[1]] ?? cols[1];
    const entry: SsEntry = {
      transport,
      state,
      local: parseAddr(cols[4]),
      peer: parseAddr(cols[5]),
    };
    const rest = cols.slice(6).join(' ');
    const proc = /users:\(\("([^"]+)",pid=(\d+)/.exec(rest);
    if (proc) {
      entry.process = proc[1];
      entry.pid = Number(proc[2]);
    }
    entries.push(entry);
  }
  return entries;
}

export function isLoopback(ip: string): boolean {
  return ip.startsWith('127.') || ip === '::1' || ip === 'localhost';
}
