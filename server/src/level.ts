import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { MachineKind, TargetConnection } from '../../shared/protocol.ts';

export interface LevelService {
  name: string; // process name, e.g. sshd
  port: number;
  transport?: 'tcp' | 'udp';
  running?: boolean; // default true
}

export interface LevelMachine {
  id: string;
  kind: MachineKind;
  user: string;
  terminal?: boolean; // player gets a terminal tab on it
  networks: Record<string, string>; // network id → ip
  services?: LevelService[];
  firewall?: { drop?: number[] }; // simulator only: ports that silently time out
  password?: string; // simulator only (shown in the level brief)
}

export interface Level {
  id: string;
  title: string;
  brief: string;
  networks: { id: string; name?: string; subnet: string }[];
  machines: LevelMachine[];
  target_connections?: TargetConnection[];
}

export function loadLevel(path: string): Level {
  const level = parse(readFileSync(path, 'utf8')) as Level;
  if (!level?.id || !Array.isArray(level.machines) || !Array.isArray(level.networks)) {
    throw new Error(`Invalid level file ${path}: needs id, networks and machines`);
  }
  return level;
}
