import { describe, expect, it } from 'vitest';
import { plainText, ShellTap, type FinishedCommand } from '../src/shellTap.ts';

const mark = (kind: string, host: string, arg: string) => `\x1b]7777;netgame;${kind};${host};${arg}\x07`;
const cmd = (host: string, line: string) => mark('cmd', host, Buffer.from(line).toString('base64'));

function tap() {
  const cmds: FinishedCommand[] = [];
  const prompts: string[] = [];
  const t = new ShellTap((c) => cmds.push(c), (m, u) => prompts.push(`${u}@${m}`));
  return { t, cmds, prompts };
}

describe('shell tap', () => {
  it('strips markers and reports finished commands with their output', () => {
    const { t, cmds, prompts } = tap();
    const shown = t.feed(
      `${mark('prompt', 'laptop', 'dev')}dev@laptop:~$ curl web-01\r\n${cmd('laptop', 'curl web-01')}` +
        `curl: (7) Failed to connect to web-01 port 80: Connection refused\r\n${mark('done', 'laptop', '7')}`,
    );
    expect(shown).toBe('dev@laptop:~$ curl web-01\r\ncurl: (7) Failed to connect to web-01 port 80: Connection refused\r\n');
    expect(prompts).toEqual(['dev@laptop']);
    expect(cmds).toEqual([
      { machine: 'laptop', line: 'curl web-01', output: 'curl: (7) Failed to connect to web-01 port 80: Connection refused\n', exitCode: 7 },
    ]);
  });

  it('handles markers split across chunks', () => {
    const { t, cmds } = tap();
    const all = `${cmd('laptop', 'ping -c 1 web-01')}1 received\r\n${mark('done', 'laptop', '0')}$ `;
    let shown = '';
    for (const ch of all) shown += t.feed(ch);
    expect(shown).toBe('1 received\r\n$ ');
    expect(cmds).toEqual([{ machine: 'laptop', line: 'ping -c 1 web-01', output: '1 received\n', exitCode: 0 }]);
  });

  it('keeps commands on each machine of an ssh chain apart', () => {
    const { t, cmds, prompts } = tap();
    t.feed(`${cmd('laptop', 'ssh web-01')}Welcome to web-01\r\n`);
    t.feed(`${mark('prompt', 'web-01', 'dev')}$ ${cmd('web-01', "psql -h db-01 -U app -c 'select 1'")} ?column? \r\n${mark('done', 'web-01', '0')}`);
    t.feed(`${mark('prompt', 'web-01', 'dev')}$ ${cmd('web-01', 'exit')}logout\r\nConnection to web-01 closed.\r\n`);
    t.feed(`${mark('done', 'laptop', '0')}${mark('prompt', 'laptop', 'dev')}`);
    expect(prompts).toEqual(['dev@web-01', 'dev@web-01', 'dev@laptop']);
    expect(cmds.map((c) => [c.machine, c.line, c.output])).toEqual([
      ['web-01', "psql -h db-01 -U app -c 'select 1'", ' ?column? \n'],
      ['laptop', 'ssh web-01', 'Welcome to web-01\n'],
    ]);
  });

  it('removes colors and cursor moves from captured output', () => {
    expect(plainText('\x1b[1;31mrefused\x1b[0m\r\n\x1b]0;title\x07ok\r')).toBe('refused\nok');
  });
});
