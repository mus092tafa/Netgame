// Turns per-machine socket tables into listening ports and deduplicated edges.
import type { ListeningPort, MapEdge } from '../../shared/protocol.ts';
import { lookupService } from '../../shared/services.ts';
import { isLoopback, type SsEntry } from './ssParser.ts';

export interface MachineSockets {
  machine: string;
  entries: SsEntry[];
}

/** States that mean "this connection is live (or being opened)". */
const LIVE_STATES = new Set(['ESTAB', 'SYN-SENT', 'SYN-RECV']);

export function listeningPorts(entries: SsEntry[]): ListeningPort[] {
  const seen = new Map<string, ListeningPort>();
  for (const e of entries) {
    const listening = (e.transport === 'tcp' && e.state === 'LISTEN') || (e.transport === 'udp' && e.state === 'UNCONN');
    if (!listening || e.local.port == null) continue;
    // Docker's embedded DNS and other loopback-only listeners aren't reachable from other machines.
    if (isLoopback(e.local.ip)) continue;
    const key = `${e.transport}:${e.local.port}`;
    if (seen.has(key)) continue;
    const svc = lookupService(e.local.port, e.transport, e.process);
    seen.set(key, {
      port: e.local.port,
      transport: e.transport,
      process: e.process ?? '?',
      service: svc.name,
    });
  }
  return [...seen.values()].sort((a, b) => a.port - b.port);
}

export interface CorrelatedEdge extends MapEdge {
  bytes?: number;
}

export function edgeId(transport: string, cIp: string, cPort: number, sIp: string, sPort: number): string {
  return `${transport}:${cIp}:${cPort}>${sIp}:${sPort}`;
}

/**
 * Matches local/peer IP:port pairs to known machines. A connection seen from both ends is one edge.
 * The side whose port is a listening port is the server (arrow points at it).
 */
export function correlate(
  machines: MachineSockets[],
  ipToMachine: Map<string, string>,
  now: number,
): CorrelatedEdge[] {
  const listenByMachine = new Map<string, Set<string>>();
  for (const m of machines) {
    listenByMachine.set(
      m.machine,
      new Set(listeningPorts(m.entries).map((l) => `${l.transport}:${l.port}`)),
    );
  }
  const isListening = (machine: string | null, transport: string, port: number) =>
    machine != null && (listenByMachine.get(machine)?.has(`${transport}:${port}`) ?? false);

  const edges = new Map<string, CorrelatedEdge>();
  for (const m of machines) {
    for (const e of m.entries) {
      if (!LIVE_STATES.has(e.state)) continue;
      if (e.local.port == null || e.peer.port == null) continue;
      if (isLoopback(e.local.ip) || isLoopback(e.peer.ip)) continue;
      const peerMachine = ipToMachine.get(e.peer.ip) ?? null;

      let localIsServer: boolean;
      if (isListening(m.machine, e.transport, e.local.port)) localIsServer = true;
      else if (isListening(peerMachine, e.transport, e.peer.port)) localIsServer = false;
      else if (e.state === 'SYN-SENT') localIsServer = false;
      else localIsServer = e.local.port < e.peer.port; // well-known ports are low

      const local = { machine: m.machine, ip: e.local.ip, port: e.local.port };
      const peer = { machine: peerMachine, ip: e.peer.ip, port: e.peer.port };
      const client = localIsServer ? peer : local;
      const server = localIsServer ? local : peer;
      const id = edgeId(e.transport, client.ip, client.port, server.ip, server.port);

      const bytes = (e.bytesSent ?? 0) + (e.bytesReceived ?? 0);
      const existing = edges.get(id);
      if (existing) {
        if (localIsServer) existing.process = e.process ?? existing.process;
        else existing.clientProcess = e.process ?? existing.clientProcess;
        if (e.state === 'ESTAB') existing.state = 'ESTABLISHED';
        if (bytes > (existing.bytes ?? 0)) existing.bytes = bytes;
        continue;
      }
      const svc = lookupService(server.port, e.transport, localIsServer ? e.process : undefined);
      edges.set(id, {
        id,
        client,
        server,
        transport: e.transport,
        service: svc.name,
        category: svc.category,
        state: e.state === 'ESTAB' ? 'ESTABLISHED' : e.state,
        process: localIsServer ? e.process : undefined,
        clientProcess: localIsServer ? undefined : e.process,
        openedAt: now,
        bytes: bytes || undefined,
      });
    }
  }
  return [...edges.values()];
}
