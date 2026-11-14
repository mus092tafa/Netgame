// Wire protocol shared by the backend and the map frontend.
// The backend sends a full `snapshot` when a client connects and then only diffs.

export type MachineKind = 'laptop' | 'server' | 'database' | 'dns' | 'router';
export type Transport = 'tcp' | 'udp';

/** Color group used by the map and its legend. */
export type ServiceCategory = 'ssh' | 'http' | 'https' | 'db' | 'dns' | 'icmp' | 'unknown';

export interface Zone {
  id: string; // docker network name
  name: string;
  subnet: string; // e.g. 10.10.0.0/24
}

export interface Iface {
  network: string; // Zone.id
  ip: string;
}

export interface ListeningPort {
  port: number;
  transport: Transport;
  process: string; // sshd, nginx, postgres...
  service: string; // SSH, HTTP...
}

export interface MapNode {
  id: string; // stable machine id (container name)
  hostname: string;
  kind: MachineKind;
  status: 'running' | 'stopped';
  user: string; // user logged in to its terminal
  ifaces: Iface[];
  listening: ListeningPort[];
}

export interface Endpoint {
  machine: string | null; // null = outside the known world
  ip: string;
  port: number;
}

export interface MapEdge {
  /** Stable id: same socket pair seen from both ends maps to the same id. */
  id: string;
  client: Endpoint; // who started the connection
  server: Endpoint; // who is listening
  transport: Transport;
  service: string; // "SSH", "HTTP", "TCP"...
  category: ServiceCategory;
  state: string; // ESTABLISHED, SYN-SENT...
  process?: string; // server-side process if known
  clientProcess?: string;
  openedAt: number; // epoch ms
  /** Bytes per second across both directions, when measurable. */
  rate?: number;
  /** True when it came from the command log (too fast for polling). */
  oneShot?: boolean;
}

export type FailReason = 'refused' | 'timeout' | 'no-route' | 'unknown-host';

export type MapEvent =
  | {
      kind: 'failed';
      id: string;
      at: number;
      from: string;
      to: string | null; // machine id when the target is known
      target: string; // what the player typed
      port?: number;
      service?: string;
      category: ServiceCategory;
      reason: FailReason;
      command: string;
    }
  | { kind: 'ping'; id: string; at: number; from: string; to: string; ok: boolean; command: string }
  | { kind: 'dns'; id: string; at: number; from: string; to: string; name: string; ok: boolean };

/** A goal of the level. */
export interface TargetConnection {
  from: string;
  to: string;
  /** Not used for 'ping' (ICMP has no ports). */
  port?: number;
  /**
   * What reaches it: a working connection (default), a ping that gets replies,
   * or an attempt that fails in a particular way (to learn what each failure looks like).
   */
  kind?: 'connect' | 'ping' | 'refused' | 'timeout';
  label: string;
  /** A command that does it, typed on `from`. The goals panel can explain each part of it. */
  command?: string;
}

/** Terminal tab (a shell rooted on one machine, possibly hopped elsewhere through ssh). */
export interface ShellInfo {
  tab: string;
  root: string;
  /** Machines in the ssh chain, root first. Last one is where the player's shell is. */
  chain: string[];
  /** Edge ids of the ssh hops (chain.length - 1 entries, may be null until polled). */
  hopEdges: (string | null)[];
  prompt: string;
}

export interface LevelInfo {
  id: string;
  title: string;
  brief: string;
}

export type ServerMsg =
  | {
      type: 'snapshot';
      level: LevelInfo;
      zones: Zone[];
      nodes: MapNode[];
      edges: MapEdge[];
      targets: TargetConnection[];
      shells: ShellInfo[];
      mode: 'sim' | 'docker';
      /** 'pty': a real shell, send keystrokes (term-input). 'line': the simulator, send whole lines (cmd). */
      terminal: 'pty' | 'line';
    }
  | { type: 'zones'; zones: Zone[] }
  | { type: 'node'; node: MapNode }
  | { type: 'node-removed'; id: string }
  | { type: 'edge-open'; edge: MapEdge }
  | { type: 'edge-update'; edge: MapEdge }
  | { type: 'edge-close'; id: string }
  | { type: 'event'; event: MapEvent }
  | { type: 'shells'; shells: ShellInfo[] }
  /** Terminal output. `replay` = the recent history of a real shell, sent on connect (replaces the screen). */
  | { type: 'term'; tab: string; text: string; replay?: boolean }
  | { type: 'tutor'; text: string };

export type ClientMsg =
  | { type: 'cmd'; tab: string; line: string }
  /** Keystrokes / pasted text for a real shell. */
  | { type: 'term-input'; tab: string; data: string }
  | { type: 'term-resize'; tab: string; cols: number; rows: number }
  /** Ask the tutor about a connection (payload is what the map tooltip shows). */
  | { type: 'explain'; edge?: MapEdge; event?: MapEvent }
  /** For an external terminal backend: report a finished command so failures reach the map. */
  | { type: 'cmd-log'; machine: string; line: string; output: string; exitCode: number };
