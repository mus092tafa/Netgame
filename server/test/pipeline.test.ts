import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { MapEvent, ServerMsg } from '../../shared/protocol.ts';
import { failureReason, parseCommand, processCommandLog, type LogContext } from '../src/commandLog.ts';
import { correlate, listeningPorts } from '../src/correlate.ts';
import { Engine } from '../src/engine.ts';
import { loadLevel } from '../src/level.ts';
import { SimSource } from '../src/sources/sim.ts';
import { parseAddr, parseSs } from '../src/ssParser.ts';

const LAPTOP_SS = `Netid State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process
tcp   LISTEN 0      4096   127.0.0.11:39001     0.0.0.0:*
tcp   ESTAB  0      0      10.10.0.10:51234   10.10.0.20:22    users:(("ssh",pid=42,fd=3))
\t cubic wscale:7,7 bytes_sent:3120 bytes_acked:3120 bytes_received:4210
`;
const WEB_SS = `tcp   LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))
tcp   LISTEN 0 511 [::]:80 [::]:* users:(("nginx",pid=7,fd=6))
tcp   ESTAB  0 0   [::ffff:10.10.0.20]:22 [::ffff:10.10.0.10]:51234 users:(("sshd",pid=88,fd=4))
tcp   TIME-WAIT 0 0 10.10.0.20:80 10.10.0.10:40000
`;

describe('ss parser', () => {
  it('normalizes addresses', () => {
    expect(parseAddr('[::ffff:10.0.0.1]:22')).toEqual({ ip: '10.0.0.1', port: 22 });
    expect(parseAddr('0.0.0.0:*')).toEqual({ ip: '*', port: null });
    expect(parseAddr('[::]:80')).toEqual({ ip: '*', port: 80 });
    expect(parseAddr('10.0.0.1%eth0:53')).toEqual({ ip: '10.0.0.1', port: 53 });
    expect(parseAddr('*:22')).toEqual({ ip: '*', port: 22 });
  });

  it('reads rows, processes and byte counters, skipping the header', () => {
    const rows = parseSs(LAPTOP_SS);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({ state: 'ESTAB', process: 'ssh', bytesSent: 3120, bytesReceived: 4210 });
  });

  it('lists listening ports with service names and drops loopback-only ones', () => {
    expect(listeningPorts(parseSs(LAPTOP_SS))).toEqual([]);
    expect(listeningPorts(parseSs(WEB_SS)).map((l) => `${l.port} ${l.process} ${l.service}`)).toEqual([
      '22 sshd SSH',
      '80 nginx HTTP',
    ]);
  });
});

describe('correlate', () => {
  const ipMap = new Map([
    ['10.10.0.10', 'laptop'],
    ['10.10.0.20', 'web-01'],
  ]);

  it('merges both ends into one edge pointing at the listener', () => {
    const edges = correlate(
      [
        { machine: 'laptop', entries: parseSs(LAPTOP_SS) },
        { machine: 'web-01', entries: parseSs(WEB_SS) },
      ],
      ipMap,
      0,
    );
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({
      client: { machine: 'laptop', ip: '10.10.0.10', port: 51234 },
      server: { machine: 'web-01', ip: '10.10.0.20', port: 22 },
      service: 'SSH',
      category: 'ssh',
      state: 'ESTABLISHED',
      process: 'sshd',
      clientProcess: 'ssh',
    });
  });

  it('works when only the client side is visible', () => {
    const edges = correlate([{ machine: 'laptop', entries: parseSs(LAPTOP_SS) }], ipMap, 0);
    expect(edges[0].server.machine).toBe('web-01');
    expect(edges[0].client.port).toBe(51234);
  });

  it('falls back to process name for unknown ports', () => {
    const ss = `tcp LISTEN 0 1 0.0.0.0:8080 0.0.0.0:* users:(("nginx",pid=1,fd=3))\ntcp ESTAB 0 0 10.10.0.20:8080 10.10.0.10:5000 users:(("nginx",pid=1,fd=4))\n`;
    const [e] = correlate([{ machine: 'web-01', entries: parseSs(ss) }], ipMap, 0);
    expect(e.service).toBe('HTTP');
    expect(e.server.port).toBe(8080);
  });
});

describe('command log', () => {
  it.each([
    ['ssh dev@web-01', { tool: 'ssh', host: 'web-01', port: 22 }],
    ['ssh -p 2222 -i key web-01', { tool: 'ssh', host: 'web-01', port: 2222 }],
    ['sudo curl -s https://web-01/api', { tool: 'curl', host: 'web-01', port: 443 }],
    ['curl web-01:8080 | head', { tool: 'curl', host: 'web-01', port: 8080 }],
    ['wget -O - http://10.10.0.20/', { tool: 'wget', host: '10.10.0.20', port: 80 }],
    ['nc -zv web-01 80', { tool: 'nc', host: 'web-01', port: 80, oneShot: true }],
    ['nc -w 2 web-01 80', { tool: 'nc', host: 'web-01', port: 80, oneShot: false }],
    ['telnet db-01 5432', { tool: 'telnet', host: 'db-01', port: 5432 }],
    ['ping -c 3 web-01', { tool: 'ping', host: 'web-01' }],
    ['psql -h db-01 -U app', { tool: 'psql', host: 'db-01', port: 5432 }],
    ['mysql -h db -P 3307', { tool: 'mysql', host: 'db', port: 3307 }],
  ])('parses %s', (line, expected) => {
    expect(parseCommand(line)).toMatchObject(expected);
  });

  it('ignores unrelated commands', () => {
    expect(parseCommand('ls -la')).toBeNull();
  });

  it.each([
    ['ssh: connect to host web-01 port 8080: Connection refused', 'refused'],
    ['curl: (28) Failed to connect to web-01 port 443 after 5001 ms: Timeout was reached', 'timeout'],
    ['curl: (6) Could not resolve host: db-01', 'unknown-host'],
    ['From 10.10.0.10 icmp_seq=1 Destination Host Unreachable\n100% packet loss', 'no-route'],
    ['3 packets transmitted, 0 received, 100% packet loss', 'timeout'],
    ['<html>ok</html>', null],
    // Real output captured from the Debian bookworm containers:
    ["curl: (7) Failed to connect to web-01 port 8080 after 0 ms: Couldn't connect to server", 'refused'],
    ['ssh: Could not resolve hostname db-01: Temporary failure in name resolution', 'unknown-host'],
    ['1 packets transmitted, 0 received, 100% packet loss, time 0ms', 'timeout'],
    ['(stopped after 8s: Connection timed out, no answer)', 'timeout'],
  ])('classifies %s', (out, reason) => {
    expect(failureReason(out, reason ? 1 : 0)).toBe(reason);
  });

  const ctx = (): LogContext => {
    let n = 0;
    return {
      resolve: (name) => ({ 'web-01': 'web-01', '10.10.0.20': 'web-01' })[name] ?? null,
      lookupAnywhere: (name) => ({ 'web-01': 'web-01', 'db-01': 'db-01' })[name] ?? null,
      ipOf: (m) => (m === 'laptop' ? '10.10.0.10' : '10.10.0.20'),
      dnsServer: 'dns',
      newId: () => `x${++n}`,
      now: () => 1,
    };
  };

  it('turns a refused curl into a DNS flash + failed event', () => {
    const r = processCommandLog(
      { machine: 'laptop', line: 'curl web-01:8080', output: 'curl: (7) Failed to connect to web-01 port 8080 after 0 ms: Connection refused', exitCode: 7 },
      ctx(),
    );
    expect(r.events.map((e) => e.kind)).toEqual(['dns', 'failed']);
    expect(r.events[1]).toMatchObject({ reason: 'refused', to: 'web-01', port: 8080, service: 'TCP' });
    expect(r.oneShotEdges).toHaveLength(0);
  });

  it('uses curl exit codes when -s hides the message', () => {
    const r = processCommandLog({ machine: 'laptop', line: 'curl -s web-01:8080', output: '', exitCode: 7 }, ctx());
    expect(r.events.find((e) => e.kind === 'failed')).toMatchObject({ reason: 'refused', port: 8080 });
    expect(r.oneShotEdges).toHaveLength(0);
  });

  it('creates a one-shot edge for a successful curl', () => {
    const r = processCommandLog({ machine: 'laptop', line: 'curl http://10.10.0.20/', output: '<html>', exitCode: 0 }, ctx());
    expect(r.events).toHaveLength(0); // typed an IP → no DNS lookup
    expect(r.oneShotEdges[0]).toMatchObject({ client: { machine: 'laptop' }, server: { machine: 'web-01', port: 80 }, service: 'HTTP', oneShot: true });
  });

  it('turns a ping into an ICMP event with no port', () => {
    const r = processCommandLog({ machine: 'laptop', line: 'ping -c1 10.10.0.20', output: '1 received, 0% packet loss', exitCode: 0 }, ctx());
    expect(r.events).toEqual([expect.objectContaining({ kind: 'ping', to: 'web-01', ok: true })]);
  });
});

describe('simulator end to end', () => {
  const setup = async () => {
    const level = loadLevel(resolve(__dirname, '../../levels/01-first-hops.yaml'));
    const sim = new SimSource(level);
    const msgs: ServerMsg[] = [];
    const engine = new Engine(level, sim, (m) => msgs.push(m));
    await engine.poll();
    const run = async (line: string) => {
      msgs.length = 0;
      await engine.handle({ type: 'cmd', tab: 'laptop', line }, (m) => msgs.push(m));
      return msgs.slice();
    };
    return { engine, sim, run };
  };

  it('ssh opens an SSH edge and moves the shell; exit closes it', async () => {
    const { engine, sim, run } = await setup();
    const out = await run('ssh web-01');
    const open = out.find((m) => m.type === 'edge-open');
    expect(open).toMatchObject({ edge: { client: { machine: 'laptop' }, server: { machine: 'web-01', port: 22 }, service: 'SSH' } });
    expect(sim.shells()[0].chain).toEqual(['laptop', 'web-01']);
    expect(sim.shells()[0].hopEdges[0]).toBe((open as { edge: { id: string } }).edge.id);
    expect(engine.state.edges.size).toBe(1);

    // Hop to the database from web-01: chain grows, edge from web-01.
    const psql = await run('psql -h db-01 -U app');
    expect(psql.find((m) => m.type === 'edge-open')).toMatchObject({ edge: { client: { machine: 'web-01' }, server: { machine: 'db-01', port: 5432 }, service: 'PostgreSQL' } });
    await run('\\q');
    const closed = await run('exit');
    expect(closed.some((m) => m.type === 'edge-close')).toBe(true);
    expect(engine.state.edges.size).toBe(0);
  });

  it('reports refused, blocked, unknown host and no-route', async () => {
    const { run } = await setup();
    const reasons = async (line: string) =>
      (await run(line)).flatMap((m) => (m.type === 'event' && m.event.kind === 'failed' ? [(m.event as Extract<MapEvent, { kind: 'failed' }>).reason] : []));
    expect(await reasons('curl web-01:8080')).toEqual(['refused']);
    expect(await reasons('curl https://web-01')).toEqual(['timeout']);
    expect(await reasons('ssh db-01')).toEqual(['unknown-host']);
    expect(await reasons('ping -c 1 10.20.0.30')).toEqual(['no-route']);
  });

  it('sends zones once they are known (clients may connect before the first poll)', async () => {
    const level = loadLevel(resolve(__dirname, '../../levels/01-first-hops.yaml'));
    const msgs: ServerMsg[] = [];
    const engine = new Engine(level, new SimSource(level), (m) => msgs.push(m));
    expect((engine.snapshot() as Extract<ServerMsg, { type: 'snapshot' }>).zones).toEqual([]);
    await engine.poll();
    expect(msgs.find((m) => m.type === 'zones')).toMatchObject({ zones: [{ id: 'office' }, { id: 'backend' }] });
  });

  it('stopping nginx removes the port badge', async () => {
    const { engine, run } = await setup();
    await run('ssh web-01');
    expect(engine.state.nodes.get('web-01')!.listening.map((l) => l.port)).toEqual([22, 80]);
    const out = await run('systemctl stop nginx');
    expect(out.some((m) => m.type === 'node' && m.node.id === 'web-01')).toBe(true);
    expect(engine.state.nodes.get('web-01')!.listening.map((l) => l.port)).toEqual([22]);
  });
});
