// Builds every line on the map (live edges, goals, failures, pings, DNS) and draws them.
import type { MapEvent, ServiceCategory, ShellInfo, TargetConnection } from '../../../shared/protocol.ts';
import { lookupService } from '../../../shared/services.ts';
import { edgeGoals } from '../../../shared/goals.ts';
import type { Transient, ViewEdge } from '../useNetwork.ts';
import { segment, type Pt, type Size } from './layout.ts';

export type LineKind = 'edge' | 'target' | 'failed' | 'ping' | 'dns';
export type LineCat = ServiceCategory | 'fail';

export interface LineItem {
  key: string;
  a: string;
  b: string; // node id or ghost id
  kind: LineKind;
  cat: LineCat;
  label: string;
  detail?: string;
  edge?: ViewEdge;
  event?: MapEvent;
  target?: { t: TargetConnection; i: number; achieved: boolean; just: boolean };
  chain?: boolean;
  goal?: boolean; // live edge that satisfies a goal
}

export interface Geo {
  p1: Pt;
  p2: Pt;
  mid: Pt;
  n: Pt;
}

export function ghostId(ev: MapEvent) {
  return `ghost:${ev.id}`;
}

export function buildLines(
  edges: Map<string, ViewEdge>,
  transients: Map<string, Transient>,
  targets: TargetConnection[],
  achieved: Set<number>,
  justAchieved: Set<number>,
  shell: ShellInfo | undefined,
  /** The task picked in the tasks panel (-1: none). */
  focus: number,
): LineItem[] {
  const items: LineItem[] = [];
  const chainEdges = new Set(shell?.hopEdges.filter(Boolean) as string[]);
  const liveGoal = new Set<number>();

  for (const e of edges.values()) {
    if (!e.client.machine || !e.server.machine) continue;
    const goals = edgeGoals(targets, e);
    goals.forEach((i) => !e.closingAt && liveGoal.add(i));
    items.push({
      key: `edge:${e.id}`,
      a: e.client.machine,
      b: e.server.machine,
      kind: 'edge',
      cat: e.category,
      label: `:${e.server.port} ${e.service}`,
      detail: `${e.client.ip}:${e.client.port || 'eph'} → ${e.server.ip}:${e.server.port}\n${e.transport.toUpperCase()} · ${e.oneShot ? 'OPEN→CLOSED' : e.state}${e.process ? ` · ${e.process}` : ''}`,
      edge: e,
      chain: chainEdges.has(e.id),
      goal: goals.length > 0,
    });
  }

  // Only the picked task is drawn (plus one just reached, for its burst), so the map doesn't fill up with dotted lines.
  targets.forEach((t, i) => {
    if (i !== focus && !justAchieved.has(i)) return;
    if (liveGoal.has(i)) return; // the real line is drawn instead
    const svc = lookupService(t.port ?? 0);
    const kind = t.kind ?? 'connect';
    items.push({
      key: `target:${i}`,
      a: t.from,
      b: t.to,
      kind: 'target',
      cat: kind === 'ping' ? 'icmp' : kind === 'connect' ? svc.category : 'fail',
      label:
        kind === 'ping' ? 'ICMP · ping'
        : kind === 'refused' ? `:${t.port} refused?`
        : kind === 'timeout' ? `:${t.port} blocked?`
        : `:${t.port} ${svc.name}`,
      target: { t, i, achieved: achieved.has(i), just: justAchieved.has(i) },
    });
  });

  for (const { ev } of transients.values()) {
    if (ev.kind === 'failed') {
      const ghost = !ev.to || ev.reason === 'no-route' || ev.reason === 'unknown-host';
      const label =
        ev.reason === 'refused' ? `:${ev.port} refused`
        : ev.reason === 'timeout' ? (ev.port ? `:${ev.port} blocked?` : 'no reply')
        : ev.reason === 'no-route' ? `${ev.port ? `:${ev.port} ` : ''}no route`
        : `${ev.port ? `:${ev.port} ` : ''}unknown host`;
      items.push({ key: `ev:${ev.id}`, a: ev.from, b: ghost ? ghostId(ev) : ev.to!, kind: 'failed', cat: 'fail', label, event: ev });
    } else if (ev.kind === 'ping') {
      items.push({ key: `ev:${ev.id}`, a: ev.from, b: ev.to, kind: 'ping', cat: 'icmp', label: ev.ok ? 'ICMP · no port' : 'ICMP · no reply', event: ev });
    } else {
      items.push({ key: `ev:${ev.id}`, a: ev.from, b: ev.to, kind: 'dns', cat: 'dns', label: ':53 DNS', event: ev });
    }
  }
  return items;
}

/** Parallel lines between the same two machines get sideways offsets. */
export function layoutLines(items: LineItem[], pos: (id: string) => Pt | undefined, size: (id: string) => Size): Map<string, Geo> {
  const groups = new Map<string, LineItem[]>();
  for (const it of items) {
    const k = [it.a, it.b].sort().join('|');
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  const geo = new Map<string, Geo>();
  const GAP = 26;
  for (const list of groups.values()) {
    // Stable order: real edges first, then goals, then transient events.
    const order: Record<LineKind, number> = { edge: 0, target: 1, failed: 2, ping: 3, dns: 4 };
    list.sort((x, y) => order[x.kind] - order[y.kind] || x.key.localeCompare(y.key));
    const [first] = list;
    const lo = [first.a, first.b].sort()[0];
    list.forEach((it, i) => {
      const pa = pos(it.a), pb = pos(it.b);
      if (!pa || !pb) return;
      // Offsets are measured in the lo→hi direction so both orientations share one side.
      const sign = it.a === lo ? 1 : -1;
      const off = (i - (list.length - 1) / 2) * GAP * sign;
      const s = segment(pa, size(it.a), pb, size(it.b), off);
      geo.set(it.key, s);
    });
  }
  return geo;
}

function dotTiming(rate?: number) {
  if (!rate) return { dur: 2.6, count: 2 };
  const dur = Math.max(0.55, Math.min(2.6, 2.8 - Math.log10(1 + rate) * 0.55));
  return { dur, count: rate > 1500 ? 4 : rate > 300 ? 3 : 2 };
}

const path = (p1: Pt, p2: Pt) => `M ${p1.x.toFixed(1)} ${p1.y.toFixed(1)} L ${p2.x.toFixed(1)} ${p2.y.toFixed(1)}`;

export function LineSvg({ it, g, hovered, onEnter, onLeave, onClick }: {
  it: LineItem;
  g: Geo;
  hovered: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onClick: () => void;
}) {
  const color = `var(--c-${it.cat})`;
  const closing = !!it.edge?.closingAt;
  const cls = ['line', `line-${it.kind}`, closing && 'closing', it.chain && 'chain', hovered && 'hovered', it.target?.achieved && 'achieved'].filter(Boolean).join(' ');
  const hit = (d: string) => (
    <path d={d} className="line-hit" onPointerEnter={onEnter} onPointerLeave={onLeave} onClick={(e) => { e.stopPropagation(); onClick(); }} />
  );

  if (it.kind === 'failed' && it.event?.kind === 'failed' && it.event.reason === 'timeout' && !it.b.startsWith('ghost:')) {
    // Stops halfway at a wall.
    const d = path(g.p1, g.mid);
    return (
      <g className={cls} style={{ color }}>
        <path d={d} className="stroke dashed" />
        {hit(d)}
      </g>
    );
  }

  const d = path(g.p1, g.p2);
  const arrow = it.kind === 'edge' || it.kind === 'target' || (it.kind === 'failed' && it.event?.kind === 'failed' && it.event.reason === 'refused');
  const { dur, count } = dotTiming(it.edge?.rate);

  return (
    <g className={cls} style={{ color }}>
      {it.chain && <path d={d} className="chain-glow" />}
      <path
        d={d}
        className={['stroke', (it.kind === 'failed' || it.kind === 'ping') && 'dashed', it.kind === 'target' && !it.target?.achieved && 'dotted'].filter(Boolean).join(' ')}
        markerEnd={arrow ? `url(#arrow-${it.kind === 'target' && !it.target?.achieved ? 'ghost' : it.cat})` : undefined}
      />
      {it.kind === 'edge' && !closing &&
        Array.from({ length: it.edge?.oneShot ? 1 : count }, (_, i) => (
          <circle key={i} r={it.chain ? 3.6 : 3} className="dot">
            <animateMotion dur={`${it.edge?.oneShot ? 0.9 : dur}s`} repeatCount="indefinite" begin={`${(-i * dur) / count}s`} path={d} />
          </circle>
        ))}
      {it.kind === 'ping' && (
        <circle r="5" className="pulse">
          <animateMotion
            dur="1.3s"
            repeatCount="2"
            fill="freeze"
            path={d}
            keyPoints={it.event?.kind === 'ping' && it.event.ok ? '0;1;0' : '0;1'}
            keyTimes={it.event?.kind === 'ping' && it.event.ok ? '0;0.5;1' : '0;1'}
            calcMode="linear"
          />
        </circle>
      )}
      {it.kind === 'dns' && (
        <circle r="3.5" className="dot">
          <animateMotion dur="0.7s" repeatCount="2" path={d} keyPoints="0;1;0" keyTimes="0;0.5;1" calcMode="linear" />
        </circle>
      )}
      {hit(d)}
    </g>
  );
}

/** HTML parts of a line: the port flag in the middle and failure markers. */
export function LineLabel({ it, g, detailed, hovered, onEnter, onLeave, onClick }: {
  it: LineItem;
  g: Geo;
  detailed: boolean;
  hovered: boolean;
  onEnter: () => void;
  onLeave: () => void;
  onClick: () => void;
}) {
  const ev = it.event?.kind === 'failed' ? it.event : null;
  const wall = ev?.reason === 'timeout' && !it.b.startsWith('ghost:');
  const at = wall ? { x: (g.p1.x + g.mid.x) / 2, y: (g.p1.y + g.mid.y) / 2 } : g.mid;
  const showDetail = detailed && it.detail;
  const cls = [
    'flag',
    `flag-${it.kind}`,
    `cat-${it.cat}`,
    it.edge?.closingAt && 'closing',
    it.chain && 'chain',
    hovered && 'hovered',
    it.target?.achieved && 'achieved',
    it.target?.just && 'just',
  ].filter(Boolean).join(' ');
  return (
    <>
      <div
        className={cls}
        style={{ left: at.x, top: at.y }}
        onPointerEnter={onEnter}
        onPointerLeave={onLeave}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => { e.stopPropagation(); onClick(); }}
      >
        <span className="flag-dot" />
        {showDetail ? (
          <span className="flag-detail">
            {it.detail!.split('\n').map((l, i) => <span key={i}>{l}</span>)}
          </span>
        ) : (
          <span>{it.label}</span>
        )}
        {it.target?.achieved && <span className="flag-check">✓</span>}
        {it.goal && <span className="flag-check">✓</span>}
        {it.target?.just && <span className="burst" />}
      </div>
      {wall && <div className="marker wall" style={{ left: g.mid.x, top: g.mid.y }}>🧱</div>}
      {ev?.reason === 'refused' && <div className="marker cross" style={{ left: g.p2.x - (g.p2.x - g.p1.x) * 0.06, top: g.p2.y - (g.p2.y - g.p1.y) * 0.06 }}>✖</div>}
    </>
  );
}
