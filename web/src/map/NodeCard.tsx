import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ListeningPort, MapNode, Zone } from '../../../shared/protocol.ts';
import { MachineIcon } from './icons.tsx';
import type { Size } from './layout.ts';

interface Props {
  node: MapNode;
  zones: Zone[];
  x: number;
  y: number;
  here: boolean;
  inChain: boolean;
  selected: boolean;
  dim: boolean; // shares no network with the hovered machine
  onSize: (id: string, s: Size) => void;
  onPointerDown: (e: React.PointerEvent, id: string) => void;
  onHover: (id: string | null) => void;
}

/** Port badges animate in when a service starts and fade out when it stops. */
function usePortBadges(listening: ListeningPort[]) {
  const [leaving, setLeaving] = useState<ListeningPort[]>([]);
  const prev = useRef<ListeningPort[]>(listening);
  const first = useRef(true);
  useEffect(() => {
    const key = (p: ListeningPort) => `${p.transport}:${p.port}`;
    const now = new Set(listening.map(key));
    const gone = prev.current.filter((p) => !now.has(key(p)));
    prev.current = listening;
    first.current = false;
    if (!gone.length) return;
    setLeaving((l) => [...l.filter((p) => !now.has(key(p))), ...gone]);
    const t = setTimeout(() => setLeaving((l) => l.filter((p) => !gone.some((g) => key(g) === key(p)))), 900);
    return () => clearTimeout(t);
  }, [listening]);
  return { leaving, first: first.current };
}

export function NodeCard({ node, zones, x, y, here, inChain, selected, dim, onSize, onPointerDown, onHover }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const { leaving, first } = usePortBadges(node.listening);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const report = () => onSize(node.id, { w: el.offsetWidth, h: el.offsetHeight });
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    return () => ro.disconnect();
  }, [node.id, onSize]);

  const multi = node.ifaces.length > 1;
  // Merge tcp/udp duplicates for display (dnsmasq listens on both).
  const ports = [...new Map(node.listening.map((p) => [p.port, p])).values()];

  return (
    <div
      ref={ref}
      className={[
        'node',
        `kind-${node.kind}`,
        node.status === 'stopped' && 'stopped',
        here && 'here',
        inChain && 'in-chain',
        selected && 'selected',
        dim && 'dim',
      ].filter(Boolean).join(' ')}
      style={{ left: x, top: y }}
      onPointerDown={(e) => onPointerDown(e, node.id)}
      onPointerEnter={() => onHover(node.id)}
      onPointerLeave={() => onHover(null)}
      data-node={node.id}
    >
      {here && <div className="you-are-here">▼ YOU ARE HERE</div>}
      {dim && <div className="no-share">no shared network</div>}
      <span className="corner tl" /><span className="corner tr" /><span className="corner bl" /><span className="corner br" />
      <div className="node-head">
        <span className="node-icon"><MachineIcon kind={node.kind} /></span>
        <div className="node-title">
          <div className="node-host">{node.hostname}</div>
          <div className="node-user">user: {node.user}</div>
        </div>
        <span className={`status-dot ${node.status}`} title={node.status} />
      </div>
      <div className="node-ips">
        {node.ifaces.map((i) => {
          const zi = zones.findIndex((z) => z.id === i.network);
          return (
            <div key={i.network} className="node-ip">
              {i.ip}
              {multi && <span className={`ip-net zone-tint-${zi % 5}`}>{i.network}</span>}
            </div>
          );
        })}
      </div>
      {(ports.length > 0 || leaving.length > 0) && (
        <div className="badges">
          {ports.map((p) => (
            <span key={p.port} className={`badge ${first ? '' : 'badge-in'}`} title={`${p.process} is listening on ${p.transport.toUpperCase()} port ${p.port}`}>
              <b>{p.port}</b> {p.process}
            </span>
          ))}
          {leaving.map((p) => (
            <span key={`gone-${p.port}`} className="badge badge-out">
              <b>{p.port}</b> {p.process}
            </span>
          ))}
        </div>
      )}
      {ports.length === 0 && leaving.length === 0 && <div className="badges-empty">no listening ports</div>}
    </div>
  );
}
