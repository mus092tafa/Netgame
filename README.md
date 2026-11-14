# netgame

Learn networking by playing. You type real commands (`ssh`, `curl`, `ping`, `psql`…) and a live map
shows every connection you make: two machines, a line between them, and the port flagged on it.
Failed attempts show up too (refused, blocked by a firewall, unknown host), so you can see *why*.

The machines run as **Docker containers**. Without Docker, the game uses a built-in **simulator**.

## Install

You need **Git**, **Node.js 20 or newer**, and (optional, for real machines) **Docker**.

### Windows

```powershell
winget install Git.Git
winget install OpenJS.NodeJS.LTS
winget install Docker.DockerDesktop
```

Start **Docker Desktop** once, then open a **new** terminal:

```powershell
git clone https://github.com/mus092tafa/Netgame.git
cd Netgame
.\netgame.cmd install
```

### macOS

```bash
brew install git node
brew install --cask docker        # then open Docker.app once
git clone https://github.com/mus092tafa/Netgame.git
cd Netgame
./netgame install
```

If it says `~/.local/bin` isn't on your PATH, run this and open a new terminal:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
```

### Linux: Omarchy / Arch

```bash
sudo pacman -S --needed git nodejs npm docker docker-compose
sudo systemctl enable --now docker.service
sudo usermod -aG docker $USER     # then log out and back in
git clone https://github.com/mus092tafa/Netgame.git
cd Netgame
./netgame install
```

### Linux: Ubuntu / Debian

```bash
sudo apt install git curl
curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
sudo apt install nodejs
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER     # then log out and back in
git clone https://github.com/mus092tafa/Netgame.git
cd Netgame
./netgame install
```

`netgame install` adds the `netgame` command to your PATH (`~/.local/bin` on Linux/macOS, `npm link` on
Windows). You can also skip it and run `./netgame` (or `.\netgame.cmd` on Windows) from the folder.

## Play

```bash
netgame
```

The first run installs dependencies, builds the game and the Docker machines (a few minutes), then opens
**http://localhost:8787**. After that it starts in seconds.

| Command | What it does |
|---|---|
| `netgame` | Start the game (Docker if it works, otherwise the simulator) and open the browser |
| `netgame --sim` | Start with the simulator, no Docker needed |
| `netgame --docker` | Require real Docker machines (fails with a fix if Docker isn't ready) |
| `netgame --port 9000` | Use another port |
| `netgame --no-open` | Don't open the browser |
| `netgame --rebuild` | Rebuild the web app and the Docker image |
| `netgame status` | Check Node, Docker and the machines |
| `netgame stop` | Remove the game's Docker machines and networks |
| `netgame help` | Show all commands |

Press **Ctrl+C** to stop the game. The Docker machines keep running until `netgame stop`.
If Docker isn't usable, `netgame` says why, prints the fix, and starts the simulator instead.

In Docker mode the terminal panel is a real bash shell on the `laptop` machine: interactive programs
(`psql`, `top`, `vim`), Ctrl+C, tab completion and history all work. Copy and paste with Ctrl+Shift+C / Ctrl+Shift+V.
In the simulator, type `help` in the terminal panel to see what you can try.

## Develop

```bash
npm install
npm run dev        # server on :8787 (simulator) + Vite with hot reload on http://localhost:5173
npm test           # parser / correlator / command-log / simulator tests
```

## Layout

| Path | What it does |
|---|---|
| `shared/protocol.ts` | WebSocket messages: `snapshot`, then diffs (`node`, `edge-open/update/close`, `event`) |
| `shared/services.ts` | Port → service table (22 SSH, 80 HTTP, 5432 PostgreSQL…) + process-name fallback |
| `server/src/ssParser.ts` | Parses `ss -tunapi` (handles `[::ffff:…]`, `%eth0`, `-i` byte counters) |
| `server/src/correlate.ts` | Matches IP:port pairs to machines; one edge per socket pair; the listener is the server |
| `server/src/commandLog.ts` | Failed and one-shot connections from `ssh/curl/wget/nc/telnet/ping/psql/mysql/redis-cli` + output |
| `server/src/mapState.ts` | Diffing, byte rate → dot speed, short-lived one-shot edges |
| `server/src/sources/docker.ts` | Real mode: `docker inspect` + `docker exec <c> ss -tunapiH` every second |
| `server/src/sources/dockerTerminal.ts` | Real mode terminal: interactive bash in the container over the Docker Engine API |
| `server/src/shellTap.ts` | Reads the shell hook's markers: finished commands (→ command log) and prompts (→ ssh chain) |
| `server/src/sources/sim.ts` | Simulator: fake machines that print real `ss` text and realistic tool output |
| `server/src/tutor.ts` | Placeholder rule-based tutor; replace `explain()` with the real tutor |
| `web/src/map/*` | The map: zones, cards, lines, port flags, tooltips, ghosts, goals, pan/zoom |
| `levels/*.yaml` | Level topology + `target_connections` |

## Docker mode

```bash
npm run docker:up      # build + start laptop, dns, web-01, db-01 (docker/compose.yaml)
npm run dev:docker     # server reads the real containers; web on http://localhost:5173
npm run docker:down    # remove containers and networks
```

- `docker/machine/` is one Debian image for every machine; `SERVICES` picks what starts
  (`sshd nginx postgres dnsmasq`) and `DROP_PORTS` adds iptables DROP rules (web-01 blocks 443/8443).
  All machines share one SSH key for user `dev`, so hops need no password. This is fine for a sandbox,
  never for real servers.
- Containers are found by the label `netgame.level=<level id>` (+ optional `netgame.kind`); container
  names must match the level's machine ids. Docker network `netgame-office` becomes zone `office`.
- The terminal panel is a real `bash -l` with a TTY in the `laptop` container, opened through the Docker
  Engine API (`server/src/sources/dockerTerminal.ts`) and drawn with xterm.js. All browsers share it.
- `docker/machine/netgame-shell.sh` (sourced by every interactive bash) prints invisible OSC markers before
  and after each command and at each prompt, with the hostname. They pass through `ssh`, so the server
  (`server/src/shellTap.ts`) strips them and knows which command ran on which machine, its output and exit
  code. That's how failed attempts and one-shot connections (curl, ping) reach the map.
- `netgame` rebuilds the image by itself when `docker/machine/` is newer than it.
