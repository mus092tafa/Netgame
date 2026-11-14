import { useState } from 'react';
import type { MapNode, TargetConnection, Zone } from '../../../shared/protocol.ts';
import { CATEGORY_LABEL } from '../../../shared/services.ts';
import { Inline } from '../panels/Tutor.tsx';
import type { ViewEdge } from '../useNetwork.ts';
import type { LineItem } from './lines.tsx';

export function fmtDuration(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h) return `${h}h ${m % 60}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** Plain-language sentence for the tooltip (the "teaching" line). */
export function explainLine(it: LineItem, name: (id: string | null) => string, ownMachine: string | null): string {
  const who = (id: string | null) => (id && id === ownMachine ? `your ${name(id)}` : name(id));
  if (it.edge) {
    const e = it.edge;
    const c = who(e.client.machine);
    const s = name(e.server.machine);
    const listener = e.process ? `, where ${e.process} is listening` : '';
    if (e.oneShot)
      return `${cap(c)} opened a connection to port ${e.server.port} on ${s}${listener}, got its answer and closed it right away.`;
    return `${cap(c)} picked a random port (${e.client.port}) for itself and connected to port ${e.server.port} on ${s}${listener}.`;
  }
  const ev = it.event;
  if (ev?.kind === 'failed') {
    const from = who(ev.from);
    const to = ev.to ? name(ev.to) : ev.target;
    switch (ev.reason) {
      case 'refused':
        return `${to} isn't listening on port ${ev.port}. It answered "refused" straight away.`;
      case 'timeout':
        return `Nothing came back from ${to}${ev.port ? ` on port ${ev.port}` : ''}. Something (probably a firewall) is silently dropping the packets.`;
      case 'no-route':
        return `${cap(from)} shares no network with ${ev.target}${ev.to && ev.to !== ev.target ? ` (that's ${name(ev.to)})` : ''}, so there's no path to it.`;
      case 'unknown-host':
        return `${cap(from)} couldn't turn the name "${ev.target}" into an IP address, so it never even tried to connect.`;
    }
  }
  if (ev?.kind === 'ping')
    return ev.ok
      ? `${cap(who(ev.from))} sent an ICMP echo and ${name(ev.to)} echoed it back. Ping checks the machine is there, without using any port.`
      : `${cap(who(ev.from))} sent ICMP echoes to ${name(ev.to)} but none came back.`;
  if (ev?.kind === 'dns') return `${cap(who(ev.from))} asked the DNS server which IP belongs to "${ev.name}" (port 53) before connecting.`;
  if (it.target)
    return it.target.achieved
      ? `Goal reached: ${it.target.t.label}.`
      : `Goal: ${it.target.t.label}. Make this connection for real and the dotted line turns solid.`;
  return '';
}

export function Tooltip({ it, x, y, name, ownMachine, onExplain, onEnter, onLeave, now }: {
  it: LineItem;
  x: number;
  y: number;
  name: (id: string | null) => string;
  ownMachine: string | null;
  onExplain: () => void;
  onEnter: () => void;
  onLeave: () => void;
  now: number;
}) {
  let head = '';
  let meta = '';
  if (it.edge) {
    const e = it.edge;
    head = `${name(e.client.machine)} ${e.client.ip}:${e.client.port || 'ephemeral'}  →  ${name(e.server.machine)} ${e.server.ip}:${e.server.port}`;
    meta = [e.transport.toUpperCase(), e.service, e.closingAt ? 'CLOSED' : e.oneShot ? 'OPENED + CLOSED' : e.state, e.oneShot ? null : fmtDuration((e.closingAt ?? now) - e.openedAt), e.rate ? `${e.rate} B/s` : null]
      .filter(Boolean)
      .join(' · ');
  } else if (it.event?.kind === 'failed') {
    const ev = it.event;
    head = `${name(ev.from)}  →  ${ev.to ? name(ev.to) : ev.target}${ev.port ? `:${ev.port}` : ''}`;
    meta = [ev.port ? 'TCP' : 'ICMP', ev.service, { refused: 'REFUSED', timeout: 'TIMED OUT', 'no-route': 'NO ROUTE', 'unknown-host': 'UNKNOWN HOST' }[ev.reason]].filter(Boolean).join(' · ');
  } else if (it.event?.kind === 'ping') {
    head = `${name(it.event.from)}  →  ${name(it.event.to)}`;
    meta = 'ICMP · echo request/reply · no port';
  } else if (it.event?.kind === 'dns') {
    head = `${name(it.event.from)}  →  ${name(it.event.to)}:53`;
    meta = `UDP · DNS · query "${it.event.name}"`;
  } else if (it.target) {
    head = `${name(it.target.t.from)}  →  ${name(it.target.t.to)}:${it.target.t.port}`;
    meta = it.target.achieved ? 'GOAL ✓ DONE' : 'GOAL · not made yet';
  }
  const cmd = it.event && 'command' in it.event ? it.event.command : null;
  return (
    <div className={`tooltip cat-${it.cat}`} style={{ left: x, top: y }} onPointerEnter={onEnter} onPointerLeave={onLeave} onPointerDown={(e) => e.stopPropagation()}>
      <div className="tt-head">{head}</div>
      <div className="tt-meta">{meta}</div>
      {cmd && <div className="tt-cmd">$ {cmd}</div>}
      <div className="tt-explain">{explainLine(it, name, ownMachine)}</div>
      {(it.edge || it.event) && (
        <button className="btn tt-btn" onClick={onExplain}>
          ✦ Explain this
        </button>
      )}
    </div>
  );
}

export function Legend() {
  const cats = ['ssh', 'http', 'https', 'db', 'dns', 'icmp', 'unknown'] as const;
  return (
    <div className="legend panel-box">
      <div className="box-title">LEGEND</div>
      {cats.map((c) => (
        <div key={c} className="legend-row">
          <span className="swatch" style={{ background: `var(--c-${c})` }} />
          {CATEGORY_LABEL[c]}
        </div>
      ))}
      <div className="legend-row">
        <span className="swatch dashed" style={{ borderColor: 'var(--c-fail)' }} />
        Failed
      </div>
      <div className="legend-row">
        <span className="swatch dotted" />
        Goal
      </div>
    </div>
  );
}

function goalSub(t: TargetConnection, name: (id: string) => string) {
  const route = `${name(t.from)} → ${name(t.to)}`;
  switch (t.kind ?? 'connect') {
    case 'ping': return `${route} · ICMP, no port`;
    case 'refused': return `${route} :${t.port} · gets refused`;
    case 'timeout': return `${route} :${t.port} · gets no answer`;
    default: return `${route} :${t.port}`;
  }
}

/** The level's tasks: pick any one, read what it teaches, and get its command. */
export function Tasks({ targets, achieved, selected, onSelect, chain, name, onExplainCommand, onTypeCommand, onReset }: {
  targets: TargetConnection[];
  achieved: Set<number>;
  selected: number;
  onSelect: (i: number) => void;
  /** Where the terminal is: machines in its ssh chain, the current one last. */
  chain: string[];
  name: (id: string) => string;
  onExplainCommand: (command: string) => void;
  onTypeCommand: (command: string) => void;
  onReset: () => void;
}) {
  const [open, setOpen] = useState(true);
  if (!targets.length) return null;
  const t = targets[selected];
  const done = achieved.has(selected);
  const here = chain[chain.length - 1];
  return (
    <div className="tasks panel-box" onPointerDown={(e) => e.stopPropagation()}>
      <div className="box-title">
        TASKS <span className="muted">{achieved.size}/{targets.length} done</span>
        <span className="tasks-nav">
          <button disabled={selected <= 0} onClick={() => onSelect(selected - 1)} aria-label="Previous task">‹</button>
          <button disabled={selected >= targets.length - 1} onClick={() => onSelect(selected + 1)} aria-label="Next task">›</button>
          <button onClick={() => setOpen((o) => !o)} aria-label={open ? 'Collapse tasks' : 'Expand tasks'}>{open ? '–' : '+'}</button>
        </span>
      </div>
      <div className="task-steps">
        {targets.map((g, i) => (
          <button
            key={i}
            className={`task-step ${achieved.has(i) ? 'done' : ''} ${i === selected ? 'on' : ''}`}
            onClick={() => onSelect(i)}
            title={`${i + 1}. ${g.label}${achieved.has(i) ? ' (done)' : ''}`}
          >
            {achieved.has(i) ? '✓' : i + 1}
          </button>
        ))}
      </div>
      {open && t && (
        <div className="task-card">
          <div className="task-title">
            <span>Task {selected + 1} · {t.label}</span>
            {done && <span className="task-done">✓ done</span>}
          </div>
          <span className="goal-sub">{goalSub(t, name)}</span>
          {t.about && <p className="task-about"><Inline text={t.about} /></p>}
          {t.command && (
            <>
              <div className="task-where">
                Type it on <b>{name(t.from)}</b>
                {here && t && here !== t.from && (
                  <span className="task-warn">
                    {' · '}
                    <Inline text={`you are on ${name(here)} now: ${chain.includes(t.from) ? `\`exit\` back to ${name(t.from)}` : `\`ssh ${t.from}\` first`}`} />
                  </span>
                )}
              </div>
              <code className="task-cmd">{t.command}</code>
              <div className="task-actions">
                <button className="chip" onClick={() => onTypeCommand(t.command!)} title="Puts the command in the terminal. Press Enter to run it.">Type it</button>
                <button className="chip" onClick={() => onExplainCommand(t.command!)}>What does it mean?</button>
              </div>
            </>
          )}
          {achieved.size === targets.length && <div className="goal-sub">All tasks done. Replay any of them, or keep exploring: every command works.</div>}
          {achieved.size > 0 && <button className="task-reset" onClick={onReset}>Reset progress</button>}
        </div>
      )}
    </div>
  );
}

export function DetailsPanel({ node, zones, edges, name, onClose, onExplain }: {
  node: MapNode;
  zones: Zone[];
  edges: ViewEdge[];
  name: (id: string | null) => string;
  onClose: () => void;
  onExplain: (e: ViewEdge) => void;
}) {
  const mine = edges.filter((e) => !e.closingAt && (e.client.machine === node.id || e.server.machine === node.id));
  return (
    <div className="details panel-box" onPointerDown={(e) => e.stopPropagation()}>
      <div className="box-title">
        {node.hostname.toUpperCase()} <span className={`status-dot ${node.status}`} />
        <button className="x" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="dl">
        <span>kind</span><span>{node.kind}</span>
        <span>status</span><span>{node.status}</span>
        <span>user</span><span>{node.user}</span>
      </div>
      <div className="sub-title">INTERFACES</div>
      {node.ifaces.map((i, k) => (
        <div key={i.network} className="dl">
          <span>eth{k}</span>
          <span>{i.ip} <span className="muted">· {i.network} {zones.find((z) => z.id === i.network)?.subnet}</span></span>
        </div>
      ))}
      <div className="sub-title">LISTENING</div>
      {node.listening.length ? (
        node.listening.map((l) => (
          <div key={`${l.transport}${l.port}`} className="dl">
            <span>{l.port}/{l.transport}</span>
            <span>{l.process} <span className="muted">· {l.service}</span></span>
          </div>
        ))
      ) : (
        <div className="muted small">Nothing. Other machines can't connect to it.</div>
      )}
      <div className="sub-title">CONNECTIONS</div>
      {mine.length ? (
        mine.map((e) => {
          const out = e.client.machine === node.id;
          return (
            <button key={e.id} className={`conn-row cat-${e.category}`} onClick={() => onExplain(e)} title="Explain this connection">
              <span className="flag-dot" />
              {out ? `→ ${name(e.server.machine)}:${e.server.port}` : `← ${name(e.client.machine)}:${e.client.port}`}
              <span className="muted"> {e.service}</span>
            </button>
          );
        })
      ) : (
        <div className="muted small">No open connections.</div>
      )}
    </div>
  );
}
