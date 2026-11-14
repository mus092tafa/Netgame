import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { explainCommand, formatCommandHelp } from '../../shared/commandHelp.ts';
import { edgeGoals, eventGoals } from '../../shared/goals.ts';
import type { ServerMsg } from '../../shared/protocol.ts';
import { Engine } from '../src/engine.ts';
import { loadLevel } from '../src/level.ts';
import { SimSource } from '../src/sources/sim.ts';

const level = loadLevel(resolve(import.meta.dirname, '../../levels/01-first-hops.yaml'));

describe('command help', () => {
  it('explains every part of a psql command, and why it is there', () => {
    const help = explainCommand('psql -h db-01 -U app')!;
    expect(help.parts.map((p) => p.text)).toEqual(['psql', '-h db-01', '-U app']);
    expect(help.parts[1].meaning).toMatch(/host/);
    expect(help.parts[2].meaning).toMatch(/database account/);
    expect(help.signature).toBe('psql -U -h');
  });

  it('splits glued options and values, and reads URLs', () => {
    expect(explainCommand('nc -zv web-01 22')!.parts.map((p) => p.text)).toEqual(['nc', '-z (in -zv)', '-v (in -zv)', 'web-01', '22']);
    expect(explainCommand('ping -c2 web-01')!.parts[1]).toMatchObject({ text: '-c2', meaning: expect.stringMatching(/2 packets/) });
    expect(explainCommand('curl --max-time=3 web-01:8080')!.parts[2].meaning).toMatch(/no protocol.*:8080/);
    expect(explainCommand('curl -m 3 https://web-01/')!.parts[2].meaning).toMatch(/443/);
  });

  it('explains sudo and ignores the rest of a pipeline', () => {
    const help = explainCommand('sudo systemctl stop nginx | cat')!;
    expect(help.parts.map((p) => p.text)).toEqual(['sudo', 'systemctl', 'stop', 'nginx']);
  });

  it('returns nothing for tools it does not know', () => {
    expect(explainCommand('ls -la')).toBeNull();
    expect(explainCommand('')).toBeNull();
  });

  it('formats as a tutor message with a list', () => {
    expect(formatCommandHelp('ssh web-01', explainCommand('ssh web-01')!)).toMatch(/^\*\*What `ssh web-01` means\*\*\n\n.+\n\n- `ssh`: /);
  });
});

describe('level 01 goals', () => {
  it('every goal has a command that reaches it in the simulator', async () => {
    const targets = level.target_connections!;
    const msgs: ServerMsg[] = [];
    const engine = new Engine(level, new SimSource(level), (m) => msgs.push(m));
    await engine.poll();
    const reached = new Set<number>();
    const collect = () => {
      for (const m of msgs) {
        if (m.type === 'edge-open') edgeGoals(targets, m.edge).forEach((i) => reached.add(i));
        if (m.type === 'event') eventGoals(targets, m.event).forEach((i) => reached.add(i));
      }
      msgs.length = 0;
    };
    const run = async (line: string) => {
      await engine.handle({ type: 'cmd', tab: 'laptop', line }, () => {});
      collect();
    };
    // Goal commands are typed on their `from` machine: hop there first when needed.
    for (const [i, t] of targets.entries()) {
      expect(t.command, `goal ${i} has a command`).toBeTruthy();
      if (t.from !== 'laptop') await run(`ssh ${t.from}`);
      await run(t.command!);
      expect(reached.has(i), `goal ${i}: ${t.label}`).toBe(true);
      if (t.command!.startsWith('psql')) await run('\\q');
      if (t.command!.startsWith('ssh')) await run('exit');
      if (t.from !== 'laptop') await run('exit');
    }
  });

  it('the tutor explains a command the first time it is used that way', async () => {
    const msgs: ServerMsg[] = [];
    const engine = new Engine(level, new SimSource(level), (m) => msgs.push(m));
    await engine.poll();
    const tutor = async (line: string) => {
      msgs.length = 0;
      await engine.handle({ type: 'cmd', tab: 'laptop', line }, () => {});
      return msgs.filter((m) => m.type === 'tutor').length;
    };
    expect(await tutor('ping -c 1 web-01')).toBe(1);
    expect(await tutor('ping -c 3 dns')).toBe(0); // same options, already explained
    expect(await tutor('ping web-01 -c 1 -q')).toBe(1); // new option
  });
});
