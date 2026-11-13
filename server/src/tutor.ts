// Placeholder tutor: plain-language explanations built from the connection data.
// Swap `explain` for a call to the real tutor (LLM) — the inputs are already structured.
import type { MapEdge, MapEvent } from '../../shared/protocol.ts';
import type { TopologyIndex } from './topology.ts';

const SERVICE_BLURB: Record<string, string> = {
  SSH: 'SSH gives you a remote shell: what you type runs on the other machine, encrypted on the way.',
  HTTP: 'HTTP is how web pages are fetched: the client asks for a path, the server answers with a status code and content.',
  HTTPS: 'HTTPS is HTTP wrapped in TLS encryption, so nobody in between can read it.',
  PostgreSQL: 'PostgreSQL is a database server; apps keep a connection open and send SQL queries over it.',
  MySQL: 'MySQL is a database server; apps keep a connection open and send SQL queries over it.',
  Redis: 'Redis is an in-memory key/value store, often used as a cache.',
  DNS: 'DNS turns names like web-01 into IP addresses.',
};

export function explain(topo: TopologyIndex, edge?: MapEdge, ev?: MapEvent): string {
  const name = (id: string | null, fallback: string) => (id ? topo.node(id)?.hostname ?? id : fallback);
  if (edge) {
    const c = name(edge.client.machine, edge.client.ip);
    const s = name(edge.server.machine, edge.server.ip);
    const proc = edge.process ? ` A program called **${edge.process}** is listening there.` : '';
    const eph = edge.client.port
      ? `${c} picked a random "ephemeral" port (${edge.client.port}) for its own end`
      : `${c} picked a random "ephemeral" port for its own end (it was too quick for us to catch the number)`;
    return [
      `**${c} → ${s} on port ${edge.server.port} (${edge.service})**`,
      `${eph} and connected to port ${edge.server.port} on ${s} (${edge.server.ip}).${proc}`,
      `The arrow points at ${s} because that's the side that was *listening* — it waited for someone to connect.`,
      SERVICE_BLURB[edge.service] ?? `Port ${edge.server.port} isn't a well-known port, so we just call it ${edge.transport.toUpperCase()}.`,
      edge.oneShot
        ? 'This connection opened and closed in a blink (one request, one answer), so the line only flashes.'
        : `State: ${edge.state}. The line stays as long as the connection is open.`,
    ].join('\n\n');
  }
  if (ev?.kind === 'failed') {
    const from = name(ev.from, ev.from);
    const to = ev.to ? name(ev.to, ev.target) : ev.target;
    switch (ev.reason) {
      case 'refused':
        return `**${to} refused the connection on port ${ev.port}.**\n\nThe machine is up and answered, but nothing is listening on port ${ev.port}. Its answer was basically "nobody here". Look at the port badges on ${to}'s card: those are the ports that *are* open. Maybe the service is stopped, or you used the wrong port.`;
      case 'timeout':
        return `**No answer from ${to}${ev.port ? ` on port ${ev.port}` : ''}.**\n\nUnlike "refused", the other side never replied at all. That usually means a firewall silently drops the packets (the 🧱 on the map), or the machine is down.`;
      case 'no-route':
        return `**${from} has no way to reach ${to}.**\n\n${from} and ${to} aren't on any shared network. Look at the shaded zones on the map: a machine can only talk directly to machines in a zone it belongs to. Try hopping through a machine that sits in both zones.`;
      case 'unknown-host':
        return `**"${ev.target}" couldn't be resolved to an IP address.**\n\nBefore connecting, ${from} has to turn the name into an IP (DNS). Either the name is misspelled or that machine isn't visible from ${from}'s network.`;
    }
  }
  if (ev?.kind === 'ping') {
    return `**Ping from ${name(ev.from, ev.from)} to ${name(ev.to, ev.to)}.**\n\nPing uses ICMP, which sits *below* ports: it just asks "are you there?" and the machine answers. That's why the line has no port flag. A working ping proves the machine is reachable, not that any service is running.`;
  }
  if (ev?.kind === 'dns') {
    return `**DNS lookup for "${ev.name}".**\n\n${name(ev.from, ev.from)} asked the DNS server (port 53) which IP belongs to that name, before making the real connection.`;
  }
  return 'Pick a line on the map and press "Explain this".';
}
