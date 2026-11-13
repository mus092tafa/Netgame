// Polling loop: topology + `ss` from every machine → correlated edges → diffs.
import type { ClientMsg, MapNode, ServerMsg } from '../../shared/protocol.ts';
import { processCommandLog } from './commandLog.ts';
import { correlate, listeningPorts } from './correlate.ts';
import type { Level } from './level.ts';
import { MapState } from './mapState.ts';
import type { MachineSource } from './sources/source.ts';
import { SimSource, type ShellRunner } from './sources/sim.ts';
import { parseSs } from './ssParser.ts';
import { TopologyIndex } from './topology.ts';
import { explain } from './tutor.ts';

export class Engine {
  readonly state: MapState;
  private topo = new TopologyIndex([], []);
  private seq = 0;
  private polling = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private level: Level,
    private source: MachineSource,
    private broadcast: (msg: ServerMsg) => void,
    private shell: ShellRunner | null = source instanceof SimSource ? source : null,
  ) {
    this.state = new MapState(broadcast);
  }

  start(intervalMs = 1000) {
    void this.poll();
    this.timer = setInterval(() => void this.poll(), intervalMs);
  }

  stop() {
    clearInterval(this.timer);
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      if (this.source instanceof SimSource) this.source.tickTraffic();
      const { zones, nodes: bare } = await this.source.topology();
      const raw = await Promise.all(bare.map((n) => (n.status === 'running' ? this.source.sockets(n.id) : '')));
      const sockets = bare.map((n, i) => ({ machine: n.id, entries: parseSs(raw[i]) }));
      const nodes: MapNode[] = bare.map((n, i) => ({ ...n, listening: listeningPorts(sockets[i].entries) }));
      this.topo = new TopologyIndex(zones, nodes);
      this.state.setNodes(zones, nodes);
      this.state.applyEdges(correlate(sockets, this.topo.ipToMachine, Date.now()), Date.now());
    } catch (err) {
      console.error('[poll]', (err as Error).message);
    } finally {
      this.polling = false;
    }
  }

  setShell(shell: ShellRunner) {
    this.shell = shell;
  }

  lookup(name: string): string | null {
    return this.topo.lookupAnywhere(name);
  }

  /** Newest live edge client→server:port (used to highlight ssh hops). */
  findEdge(client: string, server: string, port: number): string | null {
    let best: { id: string; at: number } | null = null;
    for (const e of this.state.edges.values()) {
      if (e.client.machine === client && e.server.machine === server && e.server.port === port && (!best || e.openedAt >= best.at))
        best = { id: e.id, at: e.openedAt };
    }
    return best?.id ?? null;
  }

  snapshot(): ServerMsg {
    return {
      type: 'snapshot',
      level: { id: this.level.id, title: this.level.title, brief: this.level.brief },
      zones: this.state.zones,
      nodes: [...this.state.nodes.values()],
      edges: this.state.allEdges(),
      targets: this.level.target_connections ?? [],
      shells: this.shell?.shells() ?? [],
      mode: this.source.mode,
    };
  }

  /** A finished terminal command. Connection failures and one-shot connections become map events. */
  ingestCommand(entry: { machine: string; line: string; output: string; exitCode: number }) {
    const dns = this.level.machines.find((m) => m.kind === 'dns')?.id ?? null;
    const res = processCommandLog(entry, {
      resolve: (name, from) => this.topo.resolve(name, from),
      lookupAnywhere: (name) => this.topo.lookupAnywhere(name),
      ipOf: (m, t) => this.topo.ipOf(m, t),
      dnsServer: dns && dns !== entry.machine ? dns : null,
      newId: () => `e${++this.seq}`,
      now: () => Date.now(),
    });
    for (const ev of res.events) this.state.event(ev);
    for (const e of res.oneShotEdges) this.state.addOneShot(e);
  }

  async handle(msg: ClientMsg, reply: (m: ServerMsg) => void) {
    switch (msg.type) {
      case 'cmd': {
        if (!this.shell) return;
        const r = await this.shell.run(msg.tab, msg.line);
        this.broadcast({ type: 'term', tab: msg.tab, text: r.output });
        if (r.log) this.ingestCommand({ machine: r.machine, line: msg.line, output: r.output, exitCode: r.exitCode });
        await this.poll(); // don't wait for the next tick: the map should react right away
        this.broadcast({ type: 'shells', shells: this.shell.shells() });
        return;
      }
      case 'cmd-log':
        this.ingestCommand(msg);
        return;
      case 'explain':
        reply({ type: 'tutor', text: explain(this.topo, msg.edge, msg.event) });
        return;
    }
  }
}
