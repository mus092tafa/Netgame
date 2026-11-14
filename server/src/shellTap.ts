// Reads the markers that docker/machine/netgame-shell.sh prints into the terminal stream,
// removes them, and turns them into finished commands (for the command log) and prompts
// (to know which machine the shell is on). Works across ssh hops: every machine prints its own.

const START = '\x1b]7777;netgame;';
const END = '\x07';
const MAX_OUTPUT = 8192;

export interface FinishedCommand {
  machine: string;
  line: string;
  output: string;
  exitCode: number;
}

interface Running {
  line: string;
  output: string;
}

/** Strips colors, cursor moves, OSC sequences and carriage returns so the output can be pattern-matched. */
export function plainText(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][0-9A-Za-z]|\x1b[=>78]/g, '')
    .replace(/\r+\n/g, '\n')
    .replace(/\r/g, '');
}

export class ShellTap {
  private pending = '';
  /** Commands still running, by machine (an `ssh` waits on laptop while commands run on web-01). */
  private running = new Map<string, Running>();
  /** Machine whose output we're currently reading (the last one that printed a marker). */
  private current: string | null = null;

  constructor(
    private onCommand: (cmd: FinishedCommand) => void,
    private onPrompt: (machine: string, user: string) => void,
  ) {}

  /** Feeds raw terminal output; returns it with the markers removed. */
  feed(chunk: string): string {
    let s = this.pending + chunk;
    this.pending = '';
    let out = '';
    for (;;) {
      const at = s.indexOf(START);
      if (at < 0) {
        // Hold back a tail that could be the start of a marker split across chunks.
        const keep = partialPrefix(s);
        out += this.text(s.slice(0, s.length - keep));
        this.pending = s.slice(s.length - keep);
        return out;
      }
      out += this.text(s.slice(0, at));
      const end = s.indexOf(END, at + START.length);
      if (end < 0) {
        this.pending = s.slice(at);
        // A marker never gets this long; don't buffer forever if one was cut off.
        if (this.pending.length > 4096) {
          out += this.text(this.pending);
          this.pending = '';
        }
        return out;
      }
      this.marker(s.slice(at + START.length, end));
      s = s.slice(end + END.length);
    }
  }

  private text(s: string): string {
    if (s && this.current) {
      const r = this.running.get(this.current);
      if (r && r.output.length < MAX_OUTPUT) r.output = (r.output + s).slice(0, MAX_OUTPUT);
    }
    return s;
  }

  private marker(body: string) {
    const [kind, machine, ...rest] = body.split(';');
    const arg = rest.join(';');
    if (!machine) return;
    this.current = machine;
    switch (kind) {
      case 'cmd':
        this.running.set(machine, { line: Buffer.from(arg, 'base64').toString('utf8'), output: '' });
        break;
      case 'done': {
        const r = this.running.get(machine);
        this.running.delete(machine);
        if (r) this.onCommand({ machine, line: r.line, output: plainText(r.output), exitCode: Number(arg) || 0 });
        break;
      }
      case 'prompt':
        this.onPrompt(machine, arg);
        break;
    }
  }
}

/** Length of the longest suffix of `s` that is a prefix of the marker start. */
function partialPrefix(s: string): number {
  for (let n = Math.min(START.length - 1, s.length); n > 0; n--) if (START.startsWith(s.slice(s.length - n))) return n;
  return 0;
}
