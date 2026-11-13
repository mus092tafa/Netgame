// IP/hostname lookups over the current set of machines and networks.
import type { MapNode, Zone } from '../../shared/protocol.ts';

export class TopologyIndex {
  readonly ipToMachine = new Map<string, string>();
  private byId = new Map<string, MapNode>();

  constructor(readonly zones: Zone[], readonly nodes: MapNode[]) {
    for (const n of nodes) {
      this.byId.set(n.id, n);
      for (const i of n.ifaces) this.ipToMachine.set(i.ip, n.id);
    }
  }

  node(id: string) {
    return this.byId.get(id);
  }

  sharedNetworks(a: string, b: string): string[] {
    const na = this.byId.get(a);
    const nb = this.byId.get(b);
    if (!na || !nb) return [];
    const netsB = new Set(nb.ifaces.map((i) => i.network));
    return na.ifaces.map((i) => i.network).filter((n) => netsB.has(n));
  }

  /** Machine owning this name or IP, wherever it is. */
  lookupAnywhere(name: string): string | null {
    if (this.ipToMachine.has(name)) return this.ipToMachine.get(name)!;
    for (const n of this.nodes) if (n.id === name || n.hostname === name) return n.id;
    return null;
  }

  /**
   * Docker-style resolution: container names only resolve for machines that share a network;
   * IPs only route when the target has an IP on a shared network.
   */
  resolve(name: string, from: string): string | null {
    if (name === 'localhost' || name === '127.0.0.1') return from;
    const target = this.lookupAnywhere(name);
    if (!target) return null;
    if (target === from) return target;
    return this.sharedNetworks(from, target).length ? target : null;
  }

  /** IP `machine` would use to talk to `towards` (one on a shared network if possible). */
  ipOf(machine: string, towards: string): string {
    const n = this.byId.get(machine);
    if (!n || !n.ifaces.length) return '?';
    const shared = this.sharedNetworks(machine, towards);
    return (n.ifaces.find((i) => shared.includes(i.network)) ?? n.ifaces[0]).ip;
  }
}
