// WebSocket client + map store. Applies the backend's diffs and keeps short-lived visuals
// (fading edges, failed attempts, pings, DNS flashes) alive for their display time.
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ClientMsg, LevelInfo, MapEdge, MapEvent, MapNode, ServerMsg, ShellInfo, TargetConnection, Zone,
} from '../../shared/protocol.ts';

export interface ViewEdge extends MapEdge {
  closingAt?: number; // set when closed: the line fades out instead of vanishing
}

export interface Transient {
  ev: MapEvent;
  until: number;
}

export interface LogRow {
  id: number;
  t: number;
  src: string;
  dst: string;
  proto: string;
  info: string;
  category: string;
  edgeId?: string;
  eventId?: string;
}

export interface TutorMsg {
  id: number;
  from: 'tutor' | 'you';
  text: string;
}

export interface NetState {
  connected: boolean;
  mode: 'sim' | 'docker' | null;
  level: LevelInfo | null;
  zones: Zone[];
  nodes: Map<string, MapNode>;
  edges: Map<string, ViewEdge>;
  transients: Map<string, Transient>;
  targets: TargetConnection[];
  achieved: Set<number>;
  justAchieved: Set<number>;
  shells: ShellInfo[];
  term: Record<string, string>;
  log: LogRow[];
  tutor: TutorMsg[];
}

const FADE_MS = 2000;
const EVENT_MS: Record<MapEvent['kind'], number> = { failed: 5000, ping: 2600, dns: 1400 };

const initial = (): NetState => ({
  connected: false,
  mode: null,
  level: null,
  zones: [],
  nodes: new Map(),
  edges: new Map(),
  transients: new Map(),
  targets: [],
  achieved: new Set(),
  justAchieved: new Set(),
  shells: [],
  term: {},
  log: [],
  tutor: [],
});

let rowSeq = 0;

function host(s: NetState, id: string | null, ip: string) {
  return id ? s.nodes.get(id)?.hostname ?? id : ip;
}

function matchTargets(s: NetState, e: MapEdge): number[] {
  return s.targets
    .map((t, i) => (t.from === e.client.machine && t.to === e.server.machine && t.port === e.server.port ? i : -1))
    .filter((i) => i >= 0);
}

export function useNetwork() {
  const [state, setState] = useState<NetState>(initial);
  const wsRef = useRef<WebSocket | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  const later = useCallback((ms: number, fn: () => void) => {
    const t = setTimeout(() => {
      timers.current.delete(t);
      fn();
    }, ms);
    timers.current.add(t);
  }, []);

  const apply = useCallback(
    (msg: ServerMsg) => {
      setState((prev) => {
        const s: NetState = { ...prev };
        const addLog = (row: Omit<LogRow, 'id' | 't'>) => {
          s.log = [...s.log.slice(-199), { ...row, id: ++rowSeq, t: Date.now() }];
        };
        const achieve = (e: MapEdge) => {
          const hits = matchTargets(s, e).filter((i) => !s.achieved.has(i));
          if (!hits.length) return;
          s.achieved = new Set([...s.achieved, ...hits]);
          s.justAchieved = new Set([...s.justAchieved, ...hits]);
          later(1600, () => setState((p) => {
            const j = new Set(p.justAchieved);
            hits.forEach((i) => j.delete(i));
            return { ...p, justAchieved: j };
          }));
          hits.forEach((i) => addLog({ src: '★', dst: '', proto: 'GOAL', info: `Target reached: ${s.targets[i].label}`, category: 'goal' }));
        };

        switch (msg.type) {
          case 'snapshot': {
            const fresh = initial();
            Object.assign(s, fresh, {
              connected: true,
              mode: msg.mode,
              level: msg.level,
              zones: msg.zones,
              nodes: new Map(msg.nodes.map((n) => [n.id, n])),
              edges: new Map(msg.edges.map((e) => [e.id, e])),
              targets: msg.targets,
              shells: msg.shells,
              term: prev.term,
              tutor: prev.tutor.length
                ? prev.tutor
                : [{ id: 1, from: 'tutor', text: `**${msg.level.title}**\n\n${msg.level.brief}\n\nType \`help\` in the terminal to see what you can do. Hover any line on the map, or press "Explain this" on it, and I'll walk you through it.` }],
            });
            msg.edges.forEach(achieve);
            break;
          }
          case 'node': {
            s.nodes = new Map(s.nodes).set(msg.node.id, msg.node);
            if (!s.zones.length) break;
            break;
          }
          case 'node-removed': {
            s.nodes = new Map(s.nodes);
            s.nodes.delete(msg.id);
            break;
          }
          case 'edge-open':
          case 'edge-update': {
            const isNew = msg.type === 'edge-open' && !s.edges.has(msg.edge.id);
            s.edges = new Map(s.edges).set(msg.edge.id, msg.edge);
            if (isNew) {
              const e = msg.edge;
              addLog({
                src: `${host(s, e.client.machine, e.client.ip)}${e.client.port ? `:${e.client.port}` : ''}`,
                dst: `${host(s, e.server.machine, e.server.ip)}:${e.server.port}`,
                proto: e.service,
                info: e.oneShot ? `${e.clientProcess ?? 'client'} → ${e.server.port} · quick request (open+close)` : `${e.client.port} → ${e.server.port} ${e.state}`,
                category: e.category,
                edgeId: e.id,
              });
              achieve(e);
            }
            break;
          }
          case 'edge-close': {
            const e = s.edges.get(msg.id);
            if (!e || e.closingAt) break;
            s.edges = new Map(s.edges).set(msg.id, { ...e, closingAt: Date.now() });
            if (!e.oneShot)
              addLog({
                src: `${host(s, e.client.machine, e.client.ip)}:${e.client.port}`,
                dst: `${host(s, e.server.machine, e.server.ip)}:${e.server.port}`,
                proto: e.service,
                info: `${e.client.port} → ${e.server.port} closed`,
                category: e.category,
              });
            later(FADE_MS, () =>
              setState((p) => {
                const cur = p.edges.get(msg.id);
                if (!cur?.closingAt) return p; // reopened in the meantime
                const edges = new Map(p.edges);
                edges.delete(msg.id);
                return { ...p, edges };
              }),
            );
            break;
          }
          case 'event': {
            const ev = msg.event;
            // Only the newest DNS flash / ping / failure per machine pair stays, so repeats don't stack up.
            const sameKey = (e: MapEvent) =>
              `${e.kind}|${e.from}|${e.kind === 'failed' ? `${e.to ?? e.target}|${e.port}` : e.to}`;
            const tr = new Map(s.transients);
            for (const [id, t] of tr) if (sameKey(t.ev) === sameKey(ev)) tr.delete(id);
            s.transients = tr.set(ev.id, { ev, until: Date.now() + EVENT_MS[ev.kind] });
            later(EVENT_MS[ev.kind], () =>
              setState((p) => {
                const tr = new Map(p.transients);
                tr.delete(ev.id);
                return { ...p, transients: tr };
              }),
            );
            const from = host(s, ev.from, ev.from);
            if (ev.kind === 'failed') {
              const to = ev.to ? host(s, ev.to, ev.target) : ev.target;
              const why = { refused: 'Connection refused', timeout: 'No answer (blocked?)', 'no-route': 'No route to host', 'unknown-host': 'Could not resolve host' }[ev.reason];
              addLog({ src: from, dst: `${to}${ev.port ? `:${ev.port}` : ''}`, proto: ev.service ?? 'ICMP', info: `✖ ${why}`, category: 'fail', eventId: ev.id });
            } else if (ev.kind === 'ping') {
              addLog({ src: from, dst: host(s, ev.to, ev.to), proto: 'ICMP', info: ev.ok ? 'Echo request → echo reply (no port)' : 'Echo request, no reply', category: 'icmp', eventId: ev.id });
            } else {
              addLog({ src: from, dst: `${host(s, ev.to, ev.to)}:53`, proto: 'DNS', info: `Query A ${ev.name} → ${ev.ok ? 'answer' : 'NXDOMAIN'}`, category: 'dns', eventId: ev.id });
            }
            break;
          }
          case 'shells':
            s.shells = msg.shells;
            break;
          case 'term': {
            const cur = s.term[msg.tab] ?? '';
            s.term = { ...s.term, [msg.tab]: msg.text === '\x1bclear' ? '' : cur + msg.text };
            break;
          }
          case 'tutor':
            s.tutor = [...s.tutor, { id: Date.now(), from: 'tutor', text: msg.text }];
            break;
        }
        return s;
      });
    },
    [later],
  );

  useEffect(() => {
    let stopped = false;
    let retry: ReturnType<typeof setTimeout>;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;
      ws.onmessage = (e) => apply(JSON.parse(e.data));
      ws.onclose = () => {
        setState((p) => ({ ...p, connected: false }));
        if (!stopped) retry = setTimeout(connect, 1500);
      };
    };
    connect();
    const pending = timers.current;
    return () => {
      stopped = true;
      clearTimeout(retry);
      pending.forEach(clearTimeout);
      wsRef.current?.close();
    };
  }, [apply]);

  const send = useCallback((msg: ClientMsg) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) wsRef.current.send(JSON.stringify(msg));
  }, []);

  const echo = useCallback((tab: string, prompt: string, line: string) => {
    setState((p) => ({ ...p, term: { ...p.term, [tab]: (p.term[tab] ?? '') + prompt + line + '\n' } }));
  }, []);

  const askTutor = useCallback(
    (question: string, payload: { edge?: MapEdge; event?: MapEvent }) => {
      setState((p) => ({ ...p, tutor: [...p.tutor, { id: Date.now(), from: 'you', text: question }] }));
      send({ type: 'explain', ...payload });
    },
    [send],
  );

  return { state, send, echo, askTutor };
}
