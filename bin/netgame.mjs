#!/usr/bin/env node
// netgame — start the network game from a terminal (Linux, macOS, Windows).
// Uses only Node built-ins so it runs before `npm install`.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, statSync, symlinkSync, unlinkSync } from 'node:fs';
import { get } from 'node:http';
import { homedir, platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const IS_WIN = platform() === 'win32';
const COMPOSE_FILE = join(ROOT, 'docker', 'compose.yaml');

// ---------- output helpers ----------
const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code) => (s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const cyan = paint('36'), green = paint('32'), yellow = paint('33'), red = paint('31'), dim = paint('2'), bold = paint('1');
const step = (msg) => console.log(`${cyan('›')} ${msg}`);
const ok = (msg) => console.log(`${green('✔')} ${msg}`);
const warn = (msg) => console.log(`${yellow('!')} ${msg}`);
const fail = (msg, hint) => {
  console.error(`${red('✖')} ${msg}`);
  if (hint) console.error(dim(hint.replace(/^/gm, '  ')));
  process.exit(1);
};

const HELP = `${bold('netgame')} — learn networking by playing

${bold('Usage')}
  netgame [start] [options]   start the game and open it in your browser
  netgame stop                remove the game's Docker containers and networks
  netgame status              show whether Docker and the containers are ready
  netgame install             put the \`netgame\` command on your PATH
  netgame help

${bold('Options')}
  --docker        real machines in Docker containers (default when Docker works)
  --sim           built-in simulator, no Docker needed
  --port <n>      port for the game (default 8787)
  --no-open       don't open a browser
  --rebuild       rebuild the web app and the Docker image
`;

// ---------- small process helpers ----------
function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', shell: IS_WIN && cmd === 'npm', ...opts });
}
function runVisible(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: IS_WIN && cmd === 'npm', ...opts });
  return r.status === 0;
}
const has = (cmd) => {
  const r = spawnSync(IS_WIN ? 'where' : 'which', [cmd], { encoding: 'utf8' });
  return r.status === 0;
};

// ---------- checks ----------
function checkNode() {
  const major = Number(process.versions.node.split('.')[0]);
  if (major < 20)
    fail(`Node.js ${process.versions.node} is too old (need 20 or newer).`,
      IS_WIN ? 'Install the LTS from https://nodejs.org' : 'Arch/Omarchy:  sudo pacman -S nodejs npm   (or: mise use -g node@lts)');
}

/** node_modules must exist and match this OS (e.g. a copy made on Windows won't run on Linux). */
function ensureDeps(force) {
  const esbuildNative = join(ROOT, 'node_modules', '@esbuild', `${platform()}-${process.arch}`);
  const ready = existsSync(join(ROOT, 'node_modules', 'tsx')) && existsSync(join(ROOT, 'node_modules', 'vite')) && existsSync(esbuildNative);
  if (ready && !force) return;
  if (!has('npm')) fail('npm was not found.', 'Arch/Omarchy:  sudo pacman -S npm');
  step(ready ? 'Reinstalling dependencies…' : 'Installing dependencies (first run, takes a minute)…');
  // --loglevel=error hides npm's "install scripts blocked" notices; esbuild works without them.
  if (!runVisible('npm', ['install', '--no-fund', '--no-audit', '--loglevel=error'])) fail('npm install failed (see the output above).');
  ok('Dependencies installed');
}

function newestMtime(path) {
  if (!existsSync(path)) return 0;
  const st = statSync(path);
  if (!st.isDirectory()) return st.mtimeMs;
  let max = 0;
  for (const name of readdirSync(path)) max = Math.max(max, newestMtime(join(path, name)));
  return max;
}

function ensureWebBuild(force) {
  const built = join(ROOT, 'web', 'dist', 'index.html');
  const sources = Math.max(newestMtime(join(ROOT, 'web', 'src')), newestMtime(join(ROOT, 'shared')), newestMtime(join(ROOT, 'web', 'index.html')));
  if (!force && existsSync(built) && statSync(built).mtimeMs >= sources) return;
  step('Building the web app…');
  const vite = join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const r = run(process.execPath, [vite, 'build', '--logLevel', 'error'], { cwd: join(ROOT, 'web') });
  if (r.status !== 0) fail('Building the web app failed.', `${r.stdout}${r.stderr}`);
  ok('Web app built');
}

/** Returns { ok, compose, problem, hint }. */
function dockerState() {
  if (!has('docker')) {
    return { ok: false, problem: 'Docker is not installed.',
      hint: IS_WIN ? 'Install Docker Desktop: https://www.docker.com/products/docker-desktop/'
        : 'Arch/Omarchy:  sudo pacman -S docker docker-compose && sudo systemctl enable --now docker.service\n              sudo usermod -aG docker $USER   (then log out and back in)' };
  }
  const info = run('docker', ['info', '--format', '{{.ServerVersion}}']);
  if (info.status !== 0) {
    const err = `${info.stderr}`.toLowerCase();
    if (err.includes('permission denied'))
      return { ok: false, problem: 'Your user is not allowed to use Docker.',
        hint: 'sudo usermod -aG docker $USER   then log out and back in (or run: newgrp docker)' };
    return { ok: false, problem: 'Docker is installed but not running.',
      hint: IS_WIN || platform() === 'darwin' ? 'Start Docker Desktop and try again.' : 'sudo systemctl enable --now docker.service' };
  }
  if (run('docker', ['compose', 'version']).status === 0) return { ok: true, compose: ['docker', ['compose']] };
  if (has('docker-compose')) return { ok: true, compose: ['docker-compose', []] };
  return { ok: false, problem: 'Docker Compose is missing.', hint: 'Arch/Omarchy:  sudo pacman -S docker-compose' };
}

function compose(state, args, visible = true) {
  const [cmd, pre] = state.compose;
  const full = [...pre, '-f', COMPOSE_FILE, ...args];
  return visible ? runVisible(cmd, full) : run(cmd, full);
}

/** True when docker/machine/ changed after the image was built (e.g. after `git pull`). */
function imageOutdated() {
  const r = run('docker', ['image', 'inspect', '--format', '{{.Created}}', 'netgame/machine:latest']);
  if (r.status !== 0) return false; // not built yet: compose builds it anyway
  return newestMtime(join(ROOT, 'docker', 'machine')) > Date.parse(r.stdout.trim());
}

function containersUp() {
  const r = run('docker', ['ps', '--filter', 'label=netgame.level', '--format', '{{.Names}}']);
  return r.status === 0 ? r.stdout.split(/\s+/).filter(Boolean) : [];
}

// ---------- browser ----------
function openBrowser(url) {
  let cmd, args;
  if (IS_WIN) [cmd, args] = ['cmd', ['/c', 'start', '', url]]; // '' = window title argument
  else if (platform() === 'darwin') [cmd, args] = ['open', [url]];
  else {
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) return false; // headless / ssh session
    cmd = has('xdg-open') ? 'xdg-open' : has('gio') ? 'gio' : null;
    args = cmd === 'gio' ? ['open', url] : [url];
    if (!cmd) return false;
  }
  try {
    const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    p.on('error', () => {});
    p.unref();
    return true;
  } catch {
    return false;
  }
}

function waitForServer(url, ms) {
  const until = Date.now() + ms;
  return new Promise((done) => {
    const tryOnce = () => {
      const req = get(url, (res) => {
        res.resume();
        done(true);
      });
      req.on('error', () => (Date.now() > until ? done(false) : setTimeout(tryOnce, 300)));
      req.setTimeout(1000, () => req.destroy());
    };
    tryOnce();
  });
}

// ---------- commands ----------
async function start(opts) {
  checkNode();
  ensureDeps(false);
  ensureWebBuild(opts.rebuild);

  let mode = opts.mode;
  const docker = mode === 'sim' ? null : dockerState();
  if (mode === 'docker' && !docker.ok) fail(docker.problem, `${docker.hint}\n\nOr play without Docker:  netgame --sim`);
  if (!mode) {
    mode = docker.ok ? 'docker' : 'sim';
    if (!docker.ok) warn(`${docker.problem} Using the built-in simulator instead.\n  ${dim(`To use real machines: ${docker.hint.split('\n')[0]}`)}`);
  }

  if (mode === 'docker') {
    step('Starting the machines in Docker (the first time builds the image, a few minutes)…');
    const args = ['up', '-d', '--remove-orphans'];
    if (opts.rebuild || imageOutdated()) {
      if (!opts.rebuild) step('The machine image is out of date, rebuilding it…');
      args.push('--build');
    }
    if (!compose(docker, args)) fail('Starting the Docker machines failed (see the output above).');
    ok(`Machines running: ${containersUp().join(', ')}`);
  }

  const url = `http://localhost:${opts.port}`;
  step(`Starting the game server (${mode === 'docker' ? 'real Docker machines' : 'simulator'})…`);
  const tsx = join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const serverArgs = [tsx, join(ROOT, 'server', 'src', 'index.ts')];
  if (mode === 'docker') serverArgs.push('--docker');
  const server = spawn(process.execPath, serverArgs, {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, NETGAME_PORT: String(opts.port) },
  });
  server.stdout.on('data', (d) => {
    for (const line of String(d).split('\n')) if (line.trim() && !line.startsWith('netgame server on')) console.log(dim(`  ${line}`));
  });
  server.on('exit', (code) => {
    if (code) fail(`The game server stopped (exit code ${code}).`);
    process.exit(0);
  });

  const stop = () => {
    console.log('');
    step('Stopping…');
    server.kill('SIGINT');
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  if (!(await waitForServer(url, 30000))) {
    server.kill();
    fail(`The game server didn't answer on ${url}.`);
  }
  console.log('');
  console.log(`  ${bold(green('Network Game is running'))}  →  ${bold(cyan(url))}`);
  console.log(`  ${dim('Press Ctrl+C to stop.')}${mode === 'docker' ? dim(' The machines keep running; `netgame stop` removes them.') : ''}`);
  console.log('');
  if (opts.open && !openBrowser(url)) warn(`Couldn't open a browser. Open ${url} yourself.`);
}

function stopCmd() {
  const docker = dockerState();
  if (!docker.ok) fail(docker.problem, docker.hint);
  step('Removing the game machines…');
  if (!compose(docker, ['down', '--remove-orphans'])) fail('docker compose down failed.');
  ok('Stopped');
}

function status() {
  console.log(`node     ${process.versions.node}`);
  const deps = existsSync(join(ROOT, 'node_modules', '@esbuild', `${platform()}-${process.arch}`));
  console.log(`deps     ${deps ? green('installed') : yellow('not installed (netgame installs them)')}`);
  const d = dockerState();
  console.log(`docker   ${d.ok ? green('ready') : yellow(d.problem)}`);
  if (!d.ok) console.log(dim(d.hint.replace(/^/gm, '         ')));
  else {
    const up = containersUp();
    console.log(`machines ${up.length ? green(up.join(', ')) : dim('not running')}`);
  }
}

function install() {
  if (IS_WIN) {
    step('Linking `netgame` with npm…');
    if (!runVisible('npm', ['link'])) fail('npm link failed.');
    ok('Done. Open a new terminal and run: netgame');
    return;
  }
  const binDir = join(homedir(), '.local', 'bin');
  const target = join(binDir, 'netgame');
  mkdirSync(binDir, { recursive: true });
  try {
    if (lstatSync(target)) unlinkSync(target);
  } catch {
    /* nothing there */
  }
  symlinkSync(join(ROOT, 'netgame'), target);
  ok(`Linked ${target} → ${join(ROOT, 'netgame')}`);
  const onPath = (process.env.PATH ?? '').split(':').some((p) => resolve(p) === binDir);
  if (onPath) ok('Run it from anywhere: netgame');
  else warn(`${binDir} is not on your PATH. Add this to ~/.bashrc (or your shell's rc file):\n  export PATH="$HOME/.local/bin:$PATH"`);
}

// ---------- argument parsing ----------
function parse(argv) {
  const opts = { cmd: 'start', mode: null, port: 8787, open: true, rebuild: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (['start', 'stop', 'status', 'install', 'help'].includes(a)) opts.cmd = a;
    else if (a === '-h' || a === '--help') opts.cmd = 'help';
    else if (a === '--docker') opts.mode = 'docker';
    else if (a === '--sim') opts.mode = 'sim';
    else if (a === '--no-open') opts.open = false;
    else if (a === '--rebuild') opts.rebuild = true;
    else if (a === '--port') opts.port = Number(argv[++i]);
    else if (a.startsWith('--port=')) opts.port = Number(a.slice(7));
    else fail(`Unknown option: ${a}`, 'Run `netgame help` for the list of options.');
  }
  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) fail('--port needs a number between 1 and 65535.');
  return opts;
}

const opts = parse(process.argv.slice(2));
switch (opts.cmd) {
  case 'help':
    console.log(HELP);
    break;
  case 'stop':
    stopCmd();
    break;
  case 'status':
    status();
    break;
  case 'install':
    install();
    break;
  default:
    await start(opts);
}
