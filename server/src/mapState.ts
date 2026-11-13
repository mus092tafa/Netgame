// Holds the current map and emits diffs (node added/changed, edge opened/updated/closed, events).
import type { MapEdge, MapEvent, MapNode, ServerMsg, Zone } from '../../shared/protocol.ts';
import type { CorrelatedEdge } from './correlate.ts';

interface TrackedEdge extends MapEdge {
  lastBytes?: number;
  lastAt: number;
}

const ONE_SHOT_MS = 1800;

export class MapState {
  zones: Zone[] = [];
  readonly nodes = new Map<string, MapNode>();
  readonly edges = new Map<string, TrackedEdge>();
  private oneShots = new Map<string, MapEdge>();

  constructor(private emit: (msg: ServerMsg) => void) {}

  setNodes(zones: Zone[], nodes: MapNode[]) {
    this.zones = zones;
    const seen = new Set<string>();
    for (const n of nodes) {
      seen.add(n.id);
      const prev = this.nodes.get(n.id);
      if (!prev || JSON.stringify(prev) !== JSON.stringify(n)) {
        this.nodes.set(n.id, n);
        this.emit({ type: 'node', node: n });
      }
    }
    for (const id of [...this.nodes.keys()]) {
      if (!seen.has(id)) {
        this.nodes.delete(id);
        this.emit({ type: 'node-removed', id });
      }
    }
  }

  applyEdges(polled: CorrelatedEdge[], now: number) {
    const seen = new Set<string>();
    for (const e of polled) {
      seen.add(e.id);
      const prev = this.edges.get(e.id);
      const { bytes, ...edge } = e;
      if (!prev) {
        this.edges.set(e.id, { ...edge, lastBytes: bytes, lastAt: now });
        this.emit({ type: 'edge-open', edge });
        continue;
      }
      let rate = prev.rate;
      if (bytes != null && prev.lastBytes != null && now > prev.lastAt) {
        rate = Math.max(0, Math.round(((bytes - prev.lastBytes) * 1000) / (now - prev.lastAt)));
      }
      const next: TrackedEdge = {
        ...edge,
        openedAt: prev.openedAt,
        process: edge.process ?? prev.process,
        clientProcess: edge.clientProcess ?? prev.clientProcess,
        rate,
        lastBytes: bytes ?? prev.lastBytes,
        lastAt: now,
      };
      const changed = next.state !== prev.state || next.rate !== prev.rate || next.process !== prev.process;
      this.edges.set(e.id, next);
      if (changed) this.emit({ type: 'edge-update', edge: strip(next) });
    }
    for (const id of [...this.edges.keys()]) {
      if (!seen.has(id)) {
        this.edges.delete(id);
        this.emit({ type: 'edge-close', id });
      }
    }
  }

  /** Short-lived edge from the command log: shown briefly unless polling already caught it. */
  addOneShot(edge: MapEdge) {
    const caught = [...this.edges.values()].some(
      (e) =>
        e.client.machine === edge.client.machine &&
        e.server.machine === edge.server.machine &&
        e.server.port === edge.server.port &&
        edge.openedAt - e.lastAt < 2000,
    );
    if (caught) return;
    this.oneShots.set(edge.id, edge);
    this.emit({ type: 'edge-open', edge });
    setTimeout(() => {
      this.oneShots.delete(edge.id);
      this.emit({ type: 'edge-close', id: edge.id });
    }, ONE_SHOT_MS);
  }

  event(ev: MapEvent) {
    this.emit({ type: 'event', event: ev });
  }

  allEdges(): MapEdge[] {
    return [...[...this.edges.values()].map(strip), ...this.oneShots.values()];
  }
}

function strip(e: TrackedEdge): MapEdge {
  const { lastBytes: _b, lastAt: _a, ...rest } = e;
  return rest;
}
