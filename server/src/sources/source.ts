import type { MapNode, Zone } from '../../../shared/protocol.ts';

export type BareNode = Omit<MapNode, 'listening'>;

/** Where machine data comes from: real Docker containers or the built-in simulator. */
export interface MachineSource {
  readonly mode: 'sim' | 'docker';
  topology(): Promise<{ zones: Zone[]; nodes: BareNode[] }>;
  /** Raw `ss -tunapi` output from inside the machine ('' if it's stopped/unreachable). */
  sockets(machine: string): Promise<string>;
}
