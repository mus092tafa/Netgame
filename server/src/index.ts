// Usage:
//   npm run dev -w server                 → simulator (no Docker needed)
//   NETGAME_MODE=docker npm run dev -w server → read real containers labeled netgame.level=<id>
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import type { ClientMsg, ServerMsg } from '../../shared/protocol.ts';
import { Engine } from './engine.ts';
import { loadLevel } from './level.ts';
import { DockerSource } from './sources/docker.ts';
import { DockerShell } from './sources/dockerShell.ts';
import { SimSource } from './sources/sim.ts';

const root = resolve(fileURLToPath(import.meta.url), '../../..');
const levelPath = process.env.NETGAME_LEVEL ?? resolve(root, 'levels/01-first-hops.yaml');
const mode = process.env.NETGAME_MODE === 'docker' || process.argv.includes('--docker') ? 'docker' : 'sim';
const port = Number(process.env.NETGAME_PORT ?? 8787);

const level = loadLevel(levelPath);
const source = mode === 'docker' ? new DockerSource(level) : new SimSource(level);

const clients = new Set<WebSocket>();
const send = (ws: WebSocket, msg: ServerMsg) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(msg));
const broadcast = (msg: ServerMsg) => clients.forEach((c) => send(c, msg));

const engine = new Engine(level, source, broadcast);
if (mode === 'docker') {
  const shell = new DockerShell(level, (n) => engine.lookup(n), (c, s, p) => engine.findEdge(c, s, p));
  engine.setShell(shell);
  // Don't leave background ssh hops running after the server stops.
  const stop = () => void shell.closeAll().finally(() => process.exit(0));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

// Serves the built web app (web/dist) so `netgame` needs only this one process and port.
const dist = resolve(root, 'web/dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
const http = createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = resolve(dist, '.' + urlPath);
  if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = resolve(dist, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('netgame server is running, but the web app isn\'t built. Run `netgame` (or `npm run build -w web`).\n');
    return;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
});
const wss = new WebSocketServer({ server: http, path: '/ws' });

wss.on('connection', (ws) => {
  clients.add(ws);
  send(ws, engine.snapshot());
  ws.on('message', (data) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    void engine.handle(msg, (m) => send(ws, m));
  });
  ws.on('close', () => clients.delete(ws));
});

http.on('error', (err: NodeJS.ErrnoException) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${port} is already in use (is netgame already running?)` : err.message);
  process.exit(1);
});

http.listen(port, () => {
  console.log(`netgame server on :${port} · mode=${mode} · level=${level.id}`);
  engine.start(1000);
});
