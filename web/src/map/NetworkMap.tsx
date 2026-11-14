import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MapEdge, MapEvent } from '../../../shared/protocol.ts';
import type { NetState, ViewEdge } from '../useNetwork.ts';
import { autoLayout, bounds, CARD_W, DEFAULT_H, zoneHue, zoneRects, type Pt, type Rect, type Size } from './layout.ts';
import { buildLines, ghostId, layoutLines, LineLabel, LineSvg, type LineItem } from './lines.tsx';
import { NodeCard } from './NodeCard.tsx';
import { DetailsPanel, Legend, Objectives, Tooltip } from './overlays.tsx';

interface Props {
  state: NetState;
  activeTab: string | null;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  onFocusMachine: (id: string) => void;
  onExplain: (question: string, payload: { edge?: MapEdge; event?: MapEvent }) => void;
  onExplainCommand: (command: string) => void;
}

const GHOST: Size = { w: 120, h: 64 };
const storeKey = (level: string) => `netgame.layout.${level}`;

function loadPositions(level: string): Record<string, Pt> {
  try {
    return JSON.parse(localStorage.getItem(storeKey(level)) ?? '{}');
  } catch {
    return {};
  }
}
function savePositions(level: string, pos: Record<string, Pt>) {
  try {
    localStorage.setItem(storeKey(level), JSON.stringify(pos));
  } catch {
    /* private mode etc. */
  }
}

type Drag =
  | { kind: 'pan'; sx: number; sy: number; vx: number; vy: number }
  | { kind: 'node'; id: string; sx: number; sy: number; nx: number; ny: number; moved: boolean };

export function NetworkMap({ state, activeTab, theme, onToggleTheme, onFocusMachine, onExplain, onExplainCommand }: Props) {
  const levelId = state.level?.id ?? 'none';
  const nodes = useMemo(() => [...state.nodes.values()], [state.nodes]);
  const [saved, setSaved] = useState<Record<string, Pt>>({});
  const [sizes, setSizes] = useState<Record<string, Size>>({});
  const [view, setView] = useState({ x: 0, y: 0, k: 1 });
  const [detailed, setDetailed] = useState(false);
  const [hoverKey, setHoverKey] = useState<string | null>(null);
  const [pinnedKey, setPinnedKey] = useState<string | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const viewport = useRef<HTMLDivElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const leaveTimer = useRef<ReturnType<typeof setTimeout>>();
  const fitted = useRef<string | null>(null);

  useEffect(() => setSaved(loadPositions(levelId)), [levelId]);

  // Saved positions win; anything new gets the automatic layout.
  const auto = useMemo(() => autoLayout(state.zones, nodes), [state.zones, nodes]);
  const pos = useMemo(() => {
    const p: Record<string, Pt> = {};
    for (const n of nodes) p[n.id] = saved[n.id] ?? auto[n.id] ?? { x: 0, y: 0 };
    return p;
  }, [nodes, saved, auto]);

  const sizeOf = useCallback((id: string): Size => (id.startsWith('ghost:') ? GHOST : sizes[id] ?? { w: CARD_W, h: DEFAULT_H }), [sizes]);
  const onSize = useCallback((id: string, s: Size) => {
    setSizes((prev) => (prev[id] && Math.abs(prev[id].w - s.w) < 1 && Math.abs(prev[id].h - s.h) < 1 ? prev : { ...prev, [id]: s }));
  }, []);

  const name = useCallback((id: string | null) => (id ? state.nodes.get(id)?.hostname ?? id : '?'), [state.nodes]);
  const activeShell = state.shells.find((s) => s.tab === activeTab) ?? state.shells[0];
  const here = activeShell?.chain[activeShell.chain.length - 1] ?? null;
  const chainSet = new Set(activeShell?.chain ?? []);

  const zRects = useMemo(() => zoneRects(state.zones, nodes, pos, sizes), [state.zones, nodes, pos, sizes]);

  // Ghost "?" nodes for unknown hosts / no route: pushed away from the middle of the map.
  const ghosts = useMemo(() => {
    const out: { id: string; at: Pt; ev: Extract<MapEvent, { kind: 'failed' }> }[] = [];
    const all = Object.values(pos);
    const cx = all.reduce((s, p) => s + p.x, 0) / (all.length || 1);
    const cy = all.reduce((s, p) => s + p.y, 0) / (all.length || 1);
    let i = 0;
    for (const { ev } of state.transients.values()) {
      if (ev.kind !== 'failed') continue;
      if (ev.to && ev.reason !== 'no-route' && ev.reason !== 'unknown-host') continue;
      const from = pos[ev.from];
      if (!from) continue;
      let dx = from.x - cx, dy = from.y - cy;
      const len = Math.hypot(dx, dy);
      if (len < 1) { dx = 0; dy = 1; } else { dx /= len; dy /= len; }
      const ang = Math.atan2(dy, dx) + (i++ * 0.5 - 0.25);
      const dist = 230;
      out.push({ id: ghostId(ev), ev, at: { x: from.x + Math.cos(ang) * dist, y: from.y + Math.sin(ang) * dist } });
    }
    return out;
  }, [state.transients, pos]);

  const posOf = useCallback((id: string) => pos[id] ?? ghosts.find((g) => g.id === id)?.at, [pos, ghosts]);

  const items = useMemo(
    () => buildLines(state.edges, state.transients, state.targets, state.achieved, state.justAchieved, activeShell),
    [state.edges, state.transients, state.targets, state.achieved, state.justAchieved, activeShell],
  );
  const geo = useMemo(() => layoutLines(items, posOf, sizeOf), [items, posOf, sizeOf]);

  // ---- fit / zoom ----
  const fit = useCallback(() => {
    const el = viewport.current;
    if (!el) return;
    const rects: Rect[] = [
      ...Object.values(zRects),
      ...nodes.map((n) => ({ x: pos[n.id].x - sizeOf(n.id).w / 2, y: pos[n.id].y - sizeOf(n.id).h / 2 - 30, w: sizeOf(n.id).w, h: sizeOf(n.id).h + 30 })),
    ];
    const b = bounds(rects);
    if (!b) return;
    // Keep clear of the floating boxes: goals (top right) and legend (bottom strip).
    const padL = 24, padR = state.targets.length && el.clientWidth > 900 ? 290 : 24, padT = 24, padB = 48;
    const W = el.clientWidth - padL - padR, H = el.clientHeight - padT - padB;
    const k = Math.min(1.25, Math.max(0.3, Math.min(W / b.w, H / b.h)));
    setView({ k, x: padL + W / 2 - (b.x + b.w / 2) * k, y: padT + H / 2 - (b.y + b.h / 2) * k });
  }, [zRects, nodes, pos, sizeOf, state.targets.length]);

  // Fit once per level, and again if machines or zones show up later (e.g. Docker still starting).
  const fitKey = `${levelId}:${nodes.length}:${state.zones.length}`;
  useEffect(() => {
    if (fitted.current === fitKey || !nodes.length || Object.keys(sizes).length < nodes.length) return;
    fitted.current = fitKey;
    fit();
  }, [fitKey, nodes.length, sizes, fit]);

  const zoomAt = useCallback((factor: number, cx?: number, cy?: number) => {
    const el = viewport.current;
    if (!el) return;
    const px = cx ?? el.clientWidth / 2, py = cy ?? el.clientHeight / 2;
    setView((v) => {
      const k = Math.min(2.5, Math.max(0.25, v.k * factor));
      const f = k / v.k;
      return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f };
    });
  }, []);

  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [zoomAt]);

  // ---- drag: pan the background, move cards ----
  const onBgDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, vx: view.x, vy: view.y };
    setPinnedKey(null);
    setSelected(null);
  };
  const onNodeDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    drag.current = { kind: 'node', id, sx: e.clientX, sy: e.clientY, nx: pos[id].x, ny: pos[id].y, moved: false };
  };
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      if (d.kind === 'pan') setView((v) => ({ ...v, x: d.vx + dx, y: d.vy + dy }));
      else {
        if (!d.moved && Math.hypot(dx, dy) < 4) return;
        d.moved = true;
        setSaved((s) => ({ ...pos, ...s, [d.id]: { x: d.nx + dx / view.k, y: d.ny + dy / view.k } }));
      }
    };
    const up = () => {
      const d = drag.current;
      drag.current = null;
      if (d?.kind === 'node') {
        if (d.moved) setSaved((s) => (savePositions(levelId, s), s));
        else {
          setSelected(d.id);
          onFocusMachine(d.id);
        }
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [pos, view.k, levelId, onFocusMachine]);

  const resetLayout = () => {
    setSaved({});
    savePositions(levelId, {});
    fitted.current = null;
  };

  // ---- tooltip hover (with a short grace period so you can move onto the tooltip) ----
  const enter = (key: string) => {
    clearTimeout(leaveTimer.current);
    setHoverKey(key);
  };
  const leave = () => {
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => setHoverKey(null), 280);
  };
  const tipKey = hoverKey ?? pinnedKey;
  const tipItem = tipKey ? items.find((i) => i.key === tipKey) : undefined;
  const tipGeo = tipKey ? geo.get(tipKey) : undefined;

  useEffect(() => {
    if (!tipItem?.edge) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [tipItem?.edge]);

  const explain = (it: LineItem) => {
    const q = it.edge
      ? `Explain the ${it.edge.service} connection ${name(it.edge.client.machine)} → ${name(it.edge.server.machine)}:${it.edge.server.port}`
      : it.event?.kind === 'failed'
        ? `Why did \`${it.event.command}\` fail?`
        : `Explain this ${it.event?.kind === 'ping' ? 'ping' : 'DNS lookup'}`;
    onExplain(q, { edge: it.edge, event: it.event });
  };

  const fullscreen = () => {
    const el = shell.current;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else void el.requestFullscreen?.();
  };

  const focusNode = hoverNode ?? selected;
  const shares = (a: string, b: string) => {
    const na = state.nodes.get(a), nb = state.nodes.get(b);
    if (!na || !nb) return true;
    return na.ifaces.some((i) => nb.ifaces.some((j) => j.network === i.network));
  };
  const selNode = selected ? state.nodes.get(selected) : undefined;

  return (
    <div className="map-shell" ref={shell}>
      <div className="map-toolbar">
        <div className="seg">
          <button className={!detailed ? 'on' : ''} onClick={() => setDetailed(false)}>SIMPLE</button>
          <button className={detailed ? 'on' : ''} onClick={() => setDetailed(true)}>DETAILED</button>
        </div>
        <div className="spacer" />
        <button className="icon-btn" onClick={() => zoomAt(1 / 1.2)} title="Zoom out">−</button>
        <span className="zoom-label">{Math.round(view.k * 100)}%</span>
        <button className="icon-btn" onClick={() => zoomAt(1.2)} title="Zoom in">+</button>
        <button className="icon-btn" onClick={fit} title="Fit to screen">⤢</button>
        <button className="icon-btn" onClick={resetLayout} title="Reset layout">↺</button>
        <button className="icon-btn" onClick={fullscreen} title="Fullscreen">⛶</button>
        <button className="icon-btn" onClick={onToggleTheme} title="Toggle theme">{theme === 'dark' ? '☀' : '☾'}</button>
      </div>

      <div className="map-viewport" ref={viewport} onPointerDown={onBgDown}>
        <div className="grid-bg" style={{ backgroundPosition: `${view.x}px ${view.y}px`, backgroundSize: `${24 * view.k}px ${24 * view.k}px, ${120 * view.k}px ${120 * view.k}px` }} />
        <div className="world" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
          {state.zones.map((z, i) => {
            const r = zRects[z.id];
            if (!r) return null;
            return (
              <div key={z.id} className="zone" style={{ left: r.x, top: r.y, width: r.w, height: r.h, ['--zh' as string]: zoneHue(i) }}>
                <div className="zone-label">
                  {z.name} <span>· {z.subnet}</span>
                </div>
              </div>
            );
          })}

          <svg className="lines" width="1" height="1">
            <defs>
              {['ssh', 'http', 'https', 'db', 'dns', 'icmp', 'unknown', 'fail', 'ghost'].map((c) => (
                <marker key={c} id={`arrow-${c}`} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                  <path d="M0 0 L10 5 L0 10 z" fill={c === 'ghost' ? 'var(--ghost)' : `var(--c-${c})`} />
                </marker>
              ))}
            </defs>
            {items.map((it) => {
              const g = geo.get(it.key);
              return g ? (
                <LineSvg key={it.key} it={it} g={g} hovered={tipKey === it.key} onEnter={() => enter(it.key)} onLeave={leave} onClick={() => setPinnedKey(it.key)} />
              ) : null;
            })}
          </svg>

          {nodes.map((n) => (
            <NodeCard
              key={n.id}
              node={n}
              zones={state.zones}
              x={pos[n.id].x}
              y={pos[n.id].y}
              here={n.id === here}
              inChain={chainSet.has(n.id) && (activeShell?.chain.length ?? 0) > 1}
              selected={n.id === selected}
              dim={!!focusNode && focusNode !== n.id && !shares(focusNode, n.id)}
              onSize={onSize}
              onPointerDown={onNodeDown}
              onHover={setHoverNode}
            />
          ))}

          {ghosts.map((g) => (
            <div key={g.id} className="ghost-node" style={{ left: g.at.x, top: g.at.y }}>
              <div className="ghost-q">?</div>
              <div className="ghost-name">{g.ev.target}</div>
              <div className="ghost-why">{g.ev.reason === 'no-route' ? 'no route' : 'unknown host'}</div>
            </div>
          ))}

          {items.map((it) => {
            const g = geo.get(it.key);
            return g ? (
              <LineLabel key={it.key} it={it} g={g} detailed={detailed} hovered={tipKey === it.key} onEnter={() => enter(it.key)} onLeave={leave} onClick={() => setPinnedKey(it.key)} />
            ) : null;
          })}
        </div>

        {tipItem && tipGeo && (
          <Tooltip
            it={tipItem}
            x={tipGeo.mid.x * view.k + view.x}
            y={tipGeo.mid.y * view.k + view.y}
            name={name}
            ownMachine={activeShell?.root ?? null}
            onExplain={() => explain(tipItem)}
            onEnter={() => clearTimeout(leaveTimer.current)}
            onLeave={leave}
            now={now}
          />
        )}

        <Legend />
        <Objectives targets={state.targets} achieved={state.achieved} name={(id) => name(id)} onExplainCommand={onExplainCommand} />
        {selNode && (
          <DetailsPanel
            node={selNode}
            zones={state.zones}
            edges={[...state.edges.values()] as ViewEdge[]}
            name={name}
            onClose={() => setSelected(null)}
            onExplain={(e) => onExplain(`Explain the ${e.service} connection ${name(e.client.machine)} → ${name(e.server.machine)}:${e.server.port}`, { edge: e })}
          />
        )}
        {!state.connected && <div className="map-overlay">Connecting to the game server…</div>}
      </div>
    </div>
  );
}
