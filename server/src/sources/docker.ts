// Real mode: reads containers through the Docker CLI.
//   docker inspect  → machines, IPs, networks
//   docker exec ss  → listening ports + connections (needs iproute2 in the image)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Zone } from '../../../shared/protocol.ts';
import type { Level } from '../level.ts';
import type { BareNode, MachineSource } from './source.ts';

const run = promisify(execFile);

interface InspectNet {
  IPAddress: string;
}
interface Inspect {
  Name: string;
  Config: { Hostname: string; User: string; Labels: Record<string, string> | null };
  State: { Running: boolean };
  NetworkSettings: { Networks: Record<string, InspectNet> };
}

export class DockerSource implements MachineSource {
  readonly mode = 'docker' as const;
  private subnets = new Map<string, string>();
  private cached: { zones: Zone[]; nodes: BareNode[] } | null = null;
  private cachedAt = 0;

  /** Containers are matched by the label `netgame.level=<level id>`. */
  constructor(private level: Level) {}

  async topology() {
    // Topology rarely changes; refresh every 5s rather than every poll.
    if (this.cached && Date.now() - this.cachedAt < 5000) return this.cached;
    const { stdout: ids } = await run('docker', ['ps', '-aq', '--filter', `label=netgame.level=${this.level.id}`]);
    const idList = ids.split(/\s+/).filter(Boolean);
    if (!idList.length) return (this.cached = { zones: [], nodes: [] });
    const { stdout } = await run('docker', ['inspect', ...idList], { maxBuffer: 16 << 20 });
    const containers = JSON.parse(stdout) as Inspect[];

    // Docker network "netgame-office" is zone "office" in the level file.
    const zoneId = (dockerName: string) => dockerName.replace(/^netgame-/, '');
    const netNames = new Set<string>();
    const nodes: BareNode[] = containers.map((c) => {
      const id = c.Name.replace(/^\//, '');
      const levelMachine = this.level.machines.find((m) => m.id === id);
      const nets = c.NetworkSettings.Networks ?? {};
      Object.keys(nets).forEach((n) => netNames.add(n));
      return {
        id,
        hostname: c.Config.Hostname || id,
        kind: (c.Config.Labels?.['netgame.kind'] as BareNode['kind']) ?? levelMachine?.kind ?? 'server',
        status: c.State.Running ? 'running' : 'stopped',
        user: levelMachine?.user ?? (c.Config.User || 'root'),
        ifaces: Object.entries(nets).map(([network, n]) => ({ network: zoneId(network), ip: n.IPAddress })),
      };
    });

    const missing = [...netNames].filter((n) => !this.subnets.has(n));
    if (missing.length) {
      const { stdout: netOut } = await run('docker', ['network', 'inspect', ...missing]);
      for (const n of JSON.parse(netOut) as { Name: string; IPAM: { Config: { Subnet: string }[] } }[]) {
        this.subnets.set(n.Name, n.IPAM?.Config?.[0]?.Subnet ?? '');
      }
    }
    // Keep the level's zone order (it drives the left→right layout).
    const order = (id: string) => {
      const i = this.level.networks.findIndex((n) => n.id === id);
      return i < 0 ? 99 : i;
    };
    const zones: Zone[] = [...netNames]
      .map((dockerName) => {
        const id = zoneId(dockerName);
        return { id, name: this.level.networks.find((n) => n.id === id)?.name ?? id, subnet: this.subnets.get(dockerName) ?? '' };
      })
      .sort((a, b) => order(a.id) - order(b.id));
    this.cached = { zones, nodes };
    this.cachedAt = Date.now();
    return this.cached;
  }

  async sockets(machine: string): Promise<string> {
    try {
      const { stdout } = await run('docker', ['exec', machine, 'ss', '-tunapiH'], { timeout: 2000 });
      return stdout;
    } catch {
      return ''; // stopped, or ss not installed in the image
    }
  }
}
