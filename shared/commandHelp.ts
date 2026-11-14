// Explains a command line part by part: what the program does, and what each option and
// argument means and why it's there. Used by the tutor (after you run a command) and by the
// goals panel (before you run it). Only covers the tools the game's machines have.
import { lookupService } from './services.ts';

export interface CommandPart {
  /** As typed, e.g. "-h db-01". */
  text: string;
  meaning: string;
}

export interface CommandHelp {
  tool: string;
  summary: string;
  parts: CommandPart[];
  /** Same tool + same options (values ignored): the tutor explains each signature once. */
  signature: string;
}

interface Opt {
  /** Name of the value it takes, if any ("host", "seconds"). */
  value?: string;
  help: (v: string) => string;
}

interface Tool {
  summary: string;
  opts: Record<string, Opt>;
  args?: (args: string[]) => string[];
}

function portName(port: string | number) {
  const svc = lookupService(Number(port));
  return svc.category === 'unknown' ? '' : ` (the usual port for ${svc.name})`;
}

function hostHelp(host: string) {
  return /^\d+\.\d+\.\d+\.\d+$/.test(host)
    ? `the machine to talk to, given as an IP address, so no DNS lookup is needed.`
    : `the machine to talk to. It's a name, so it's first turned into an IP address by DNS.`;
}

function urlHelp(raw: string, tool: string) {
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `http://${raw}`);
  } catch {
    return 'the address to fetch.';
  }
  const scheme = url.protocol.replace(':', '');
  const def = scheme === 'https' ? '443' : scheme === 'http' ? '80' : '';
  return `the URL to fetch, read left to right: ${[
    hasScheme ? `\`${scheme}://\` is the protocol` : `there's no protocol, so ${tool} assumes \`http://\``,
    `\`${url.hostname}\` is the machine (DNS turns it into an IP)`,
    url.port
      ? `\`:${url.port}\` is the port, given explicitly${portName(url.port)}`
      : `no port is written, so the default for ${scheme} is used: ${def}${portName(def)}`,
    `\`${url.pathname}\` is the path of the page on that server${url.pathname === '/' ? ' (`/` is the home page)' : ''}`,
  ].join(' · ')}.`;
}

const TOOLS: Record<string, Tool> = {
  ssh: {
    summary: 'SSH opens an encrypted remote shell on another machine (port 22 by default). Everything you type afterwards runs *there*, until you type `exit`.',
    opts: {
      '-p': { value: 'port', help: (v) => `connect to port ${v} instead of the default 22.` },
      '-l': { value: 'user', help: (v) => `log in as user \`${v}\` (same as writing \`${v}@host\`).` },
      '-i': { value: 'file', help: (v) => `use the private key in \`${v}\` to prove who you are.` },
      '-v': { help: () => 'verbose: print every step of the connection. Handy for seeing *why* a login fails.' },
      '-J': { value: 'host', help: (v) => `jump: connect to ${v} first and hop through it (the network-crossing trick, in one command).` },
      '-N': { help: () => "don't start a shell, only keep the connection open (used for tunnels)." },
      '-L': { value: 'spec', help: (v) => `local port forward (${v}): a port on this machine is tunnelled through SSH to a port on the other side.` },
      '-o': { value: 'option', help: (v) => `set an SSH option (\`${v}\`).` },
    },
    args: ([dest, ...cmd]) => {
      if (!dest) return [];
      const [user, host] = dest.includes('@') ? dest.split('@') : [null, dest];
      const out = [
        user
          ? `log in to \`${host}\` as user \`${user}\` (the part before \`@\` is the account on the other machine).`
          : `the machine to log in to. There's no \`user@\` in front, so ssh uses the same username you have here.`,
      ];
      if (cmd.length) out.push('a command to run over there. ssh runs it, prints the output and disconnects, instead of giving you a shell.');
      return out;
    },
  },
  curl: {
    summary: 'curl sends one request to a server and prints the answer. For a web page: open a connection, ask for the page, get it, close. That is why its line on the map only flashes.',
    opts: {
      '-s': { help: () => 'silent: hide the progress bar and error messages.' },
      '-S': { help: () => 'show errors even when `-s` hides everything else.' },
      '-v': { help: () => 'verbose: show the whole conversation: the DNS lookup, the TCP connection, then the HTTP request and response headers.' },
      '-I': { help: () => 'only ask for the headers (status code and metadata), not the page itself.' },
      '-i': { help: () => 'print the response headers before the page.' },
      '-L': { help: () => 'follow redirects: if the server says "it moved", go there.' },
      '-k': { help: () => "don't check the HTTPS certificate (OK for tests, unsafe for real sites)." },
      '-o': { value: 'file', help: (v) => `save the answer to \`${v}\` instead of printing it${v === '/dev/null' ? ' (`/dev/null` throws it away)' : ''}.` },
      '-m': { value: 'seconds', help: (v) => `give up after ${v} seconds. Without it, curl waits about two minutes when a firewall swallows the packets silently.` },
      '--max-time': { value: 'seconds', help: (v) => `give up after ${v} seconds. Without it, curl waits about two minutes when a firewall swallows the packets silently.` },
      '--connect-timeout': { value: 'seconds', help: (v) => `give up if the connection isn't open after ${v} seconds.` },
      '-X': { value: 'method', help: (v) => `use the HTTP method ${v} instead of GET.` },
      '-H': { value: 'header', help: (v) => `send the extra header \`${v}\`.` },
      '-d': { value: 'data', help: () => 'send this data in the request body (makes it a POST).' },
      '-w': { value: 'format', help: () => 'print extra information after the transfer (e.g. `%{http_code}` = the status code).' },
    },
    args: (args) => args.map((a) => urlHelp(a, 'curl')),
  },
  wget: {
    summary: 'wget downloads a file from a web server and saves it to disk.',
    opts: {
      '-q': { help: () => 'quiet: print nothing.' },
      '-O': { value: 'file', help: (v) => `save to \`${v}\`${v === '-' ? ' (`-` means print it instead)' : ''}.` },
      '-T': { value: 'seconds', help: (v) => `give up after ${v} seconds.` },
    },
    args: (args) => args.map((a) => urlHelp(a, 'wget')),
  },
  ping: {
    summary: 'ping sends ICMP "echo request" packets and waits for "echo replies". It checks that a machine is reachable at all. ICMP has no ports, so it says nothing about which services run there.',
    opts: {
      '-c': { value: 'count', help: (v) => `stop after ${v} packet${v === '1' ? '' : 's'}. Without it, ping runs until you press Ctrl+C.` },
      '-i': { value: 'seconds', help: (v) => `wait ${v} seconds between packets (default 1).` },
      '-W': { value: 'seconds', help: (v) => `wait at most ${v} seconds for each reply.` },
      '-w': { value: 'seconds', help: (v) => `stop after ${v} seconds in total.` },
      '-q': { help: () => 'quiet: only print the summary at the end.' },
    },
    args: ([host]) => (host ? [hostHelp(host)] : []),
  },
  nc: {
    summary: 'netcat opens a raw TCP connection to a port (or UDP with `-u`). With `-z` it only checks whether the port is open, which makes it a tiny port scanner.',
    opts: {
      '-z': { help: () => "zero-I/O: connect, then hang up straight away. It's a check that the port is open." },
      '-v': { help: () => 'verbose: say whether the connection succeeded ("succeeded" / "refused").' },
      '-u': { help: () => 'use UDP instead of TCP.' },
      '-w': { value: 'seconds', help: (v) => `give up after ${v} seconds.` },
      '-l': { help: () => 'listen: be the server and wait for someone to connect.' },
      '-p': { value: 'port', help: (v) => `use port ${v}.` },
    },
    args: ([host, port]) => [
      ...(host ? [hostHelp(host)] : []),
      ...(port ? [`the port to try${portName(port)}.`] : []),
    ],
  },
  telnet: {
    summary: 'telnet opens a plain-text TCP connection to a port. Today it is mostly used to test whether a port answers.',
    opts: {},
    args: ([host, port]) => [
      ...(host ? [hostHelp(host)] : []),
      ...(port ? [`the port to connect to${portName(port)}. Without it telnet uses 23.`] : []),
    ],
  },
  psql: {
    summary: "psql is PostgreSQL's command-line client. It connects to a database server (port 5432) and lets you type SQL. `\\q` quits.",
    opts: {
      '-h': {
        value: 'host',
        help: (v) => `**host**: the machine the database server runs on. Without \`-h\`, psql looks for a database on *this* machine (through a local socket file, not the network), and there isn't one here. So \`-h ${v}\` is what makes psql go over the network to ${v}, port 5432.`,
      },
      '-U': {
        value: 'user',
        help: (v) => `**user**: the database account to log in as. \`${v}\` is a PostgreSQL role. Database accounts are separate from Linux accounts, so this isn't your Linux login. Without \`-U\`, psql would try a role named after your Linux username, which doesn't exist on the server.`,
      },
      '-d': { value: 'database', help: (v) => `**database**: which database on the server to open (\`${v}\`). Without \`-d\`, psql opens the database with the same name as the user.` },
      '-p': { value: 'port', help: (v) => `connect to port ${v} instead of 5432.` },
      '-c': { value: 'sql', help: (v) => `run this one SQL command (\`${v}\`), print the result and quit, instead of opening the \`=>\` prompt.` },
      '-l': { help: () => 'list the databases on the server and quit.' },
      '-W': { help: () => 'ask for a password before connecting.' },
    },
    args: ([db, user]) => [
      ...(db ? [`the database to open (\`${db}\`), same as \`-d ${db}\`.`] : []),
      ...(user ? [`the user to log in as (\`${user}\`), same as \`-U ${user}\`.`] : []),
    ],
  },
  dig: {
    summary: 'dig asks a DNS server which IP address belongs to a name, and shows the full answer.',
    opts: {
      '-x': { value: 'ip', help: (v) => `reverse lookup: which name belongs to ${v}?` },
    },
    args: (args) =>
      args.map((a) =>
        a.startsWith('@') ? `ask the DNS server at ${a.slice(1)} instead of the one in /etc/resolv.conf.`
        : a === '+short' ? 'print only the answer (just the IP).'
        : /^(A|AAAA|MX|NS|TXT|CNAME|SOA|PTR|ANY)$/i.test(a) ? `the record type to ask for (${a.toUpperCase()}${a.toUpperCase() === 'A' ? ' = IPv4 address' : ''}).`
        : `the name to look up.`,
      ),
  },
  nslookup: {
    summary: 'nslookup asks a DNS server which IP address belongs to a name.',
    opts: {},
    args: ([name, server]) => [
      ...(name ? ['the name to look up.'] : []),
      ...(server ? ['the DNS server to ask (instead of the default one).'] : []),
    ],
  },
  ss: {
    summary: "ss lists this machine's sockets: open connections and ports waiting for connections. It is exactly what this game reads to draw the map.",
    opts: {
      '-t': { help: () => 'show TCP sockets.' },
      '-u': { help: () => 'show UDP sockets.' },
      '-n': { help: () => 'numeric: show port numbers (22) instead of service names (ssh), and IPs instead of names.' },
      '-a': { help: () => 'all: both listening ports and open connections.' },
      '-l': { help: () => 'only listening ports (servers waiting for connections).' },
      '-p': { help: () => 'show which program owns each socket.' },
      '-i': { help: () => 'show internal TCP details (byte counters, timers).' },
      '-H': { help: () => 'no header line.' },
    },
  },
  ip: {
    summary: "ip shows and changes the machine's network settings.",
    opts: {},
    args: ([obj]) =>
      obj
        ? [
            /^a/.test(obj) ? "`addr`: list the network interfaces and their IP addresses. A machine in two networks has two."
            : /^r/.test(obj) ? '`route`: the routing table, which says where packets for each network go.'
            : /^l/.test(obj) ? '`link`: the network interfaces themselves (up/down, MAC address).'
            : 'what to show.',
          ]
        : [],
  },
  systemctl: {
    summary: 'systemctl starts, stops and checks services (the long-running programs like nginx or sshd).',
    opts: {},
    args: ([action, svc]) => {
      const actions: Record<string, string> = {
        start: 'start the service. Its port opens again',
        stop: 'stop it. Its port closes, so connections get "refused"',
        restart: 'stop it, then start it again',
        status: 'show whether it runs',
      };
      return [
        ...(action ? [actions[action] ? `${actions[action]}.` : 'what to do with the service.'] : []),
        ...(svc ? [`the service to act on (${svc}).`] : []),
      ];
    },
  },
  hostname: { summary: "hostname prints this machine's name. Useful after an ssh hop, to check where you are.", opts: { '-I': { help: () => "print this machine's IP addresses instead." } } },
  whoami: { summary: 'whoami prints the user you are logged in as.', opts: {} },
  exit: { summary: 'exit closes this shell. After an ssh hop it logs you out and takes you back to the previous machine.', opts: {} },
};
TOOLS.ncat = TOOLS.netcat = TOOLS.nc;
TOOLS.logout = TOOLS.exit;
TOOLS.host = TOOLS.nslookup;

/** Splits a command line into words, honoring quotes. Only the first command of a pipeline counts. */
function words(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\|\||&&|[|;])|(\S+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) {
    if (m[3]) break;
    out.push(m[1] ?? m[2] ?? m[4]);
  }
  return out;
}

export function explainCommand(line: string): CommandHelp | null {
  const w = words(line.trim());
  const parts: CommandPart[] = [];
  while (w.length && (w[0] === 'sudo' || /^\w+=/.test(w[0]))) {
    const word = w.shift()!;
    parts.push({ text: word, meaning: word === 'sudo' ? 'run the rest of the line as the administrator (root). Needed to start or stop services.' : 'sets an environment variable for this one command.' });
  }
  if (!w.length) return null;
  const tool = w[0].split('/').pop()!;
  const spec = TOOLS[tool];
  if (!spec) return null;
  parts.push({ text: w[0], meaning: 'the program to run.' });

  const flags: string[] = [];
  const positional: string[] = [];
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    if (a.startsWith('--') && a.length > 2) {
      const [key, inline] = a.split('=', 2);
      const opt = spec.opts[key];
      const value = opt?.value ? inline ?? w[++i] ?? '' : '';
      flags.push(key);
      parts.push({
        text: opt?.value && inline === undefined ? `${a} ${value}` : a,
        meaning: opt ? opt.help(value) : `an option this guide doesn't cover. \`${tool} --help\` or \`man ${tool}\` explains it.`,
      });
    } else if (a.startsWith('-') && a.length > 1 && !/^-\d/.test(a)) {
      // Short options can be glued together (-zv) and a value can follow without a space (-c2).
      for (let j = 1; j < a.length; j++) {
        const key = `-${a[j]}`;
        const opt = spec.opts[key];
        flags.push(key);
        if (opt?.value) {
          const glued = a.slice(j + 1);
          const value = glued || w[++i] || '';
          parts.push({ text: glued ? `${key}${glued}` : `${key} ${value}`, meaning: opt.help(value) });
          break;
        }
        parts.push({
          text: a.length > 2 ? `${key} (in ${a})` : key,
          meaning: opt ? opt.help('') : `an option this guide doesn't cover. \`man ${tool}\` explains it.`,
        });
      }
    } else positional.push(a);
  }
  const argHelp = spec.args?.(positional) ?? [];
  positional.forEach((p, i) => parts.push({ text: p, meaning: argHelp[i] ?? 'an argument for the program.' }));

  return { tool, summary: spec.summary, parts, signature: [tool, ...[...new Set(flags)].sort()].join(' ') };
}

/** Tutor-ready text (the tutor panel's small markdown: **bold**, `code`, "- " lists). */
export function formatCommandHelp(line: string, help: CommandHelp): string {
  const hasOptions = help.parts.some((p) => p.text.startsWith('-'));
  return [
    `**What \`${line.trim()}\` means**`,
    help.summary,
    help.parts.map((p) => `- \`${p.text}\`: ${p.meaning}`).join('\n'),
    hasOptions ? 'Options start with `-` (one letter, like `-h`) or `--` (a word, like `--max-time`). Some take a value, written right after them.' : '',
  ].filter(Boolean).join('\n\n');
}
