# livemerge-bridge

CLI daemon that bridges the [LiveMerge](https://livemerge.dev) web app to your local Claude Code or Codex CLI.

## How it works

1. You click "Connect my coding agent" in the LiveMerge UI — a 5-minute pairing token is generated.
2. You run `livemerge-bridge connect <token>` on your machine.
3. The daemon exchanges the token for a long-lived session, then opens a persistent WebSocket to the LiveMerge server.
4. When a task is dispatched to your agent, the daemon:
   - Verifies the Ed25519 signature (proves the dispatch came from the real LiveMerge server)
   - Spawns `claude --print "<task>"` or `codex exec "<task>"` in your project directory
   - Captures exit code, changed files (`git status --porcelain`), and stdout
   - Reports the result back to LiveMerge

## Install

### Once published (global install):

```bash
npm install -g livemerge-bridge
```

### For development / local testing:

```bash
cd packages/livemerge-bridge
npm install
npm run build
npm link
```

## Usage

```bash
livemerge-bridge connect <pairingToken> [options]
```

### Options

| Flag | Description | Default |
|---|---|---|
| `--project-dir <dir>` | Directory to run CLI tasks in | `$LIVEMERGE_PROJECT_DIR` or cwd |
| `--server-url <url>` | LiveMerge server URL | `https://livemerge.dev` |

### Examples

```bash
# Pair and start daemon with cwd as project directory
livemerge-bridge connect eyJhbGc...

# Specify project directory explicitly
livemerge-bridge connect eyJhbGc... --project-dir ~/projects/my-app

# Connect to a local dev server
livemerge-bridge connect eyJhbGc... --server-url http://localhost:3000
```

## Environment variables

| Variable | Description |
|---|---|
| `LIVEMERGE_AGENT_DIR` | Directory for `state.json` (default: `~/.livemerge-bridge/`) |
| `LIVEMERGE_PROJECT_DIR` | Default project directory for CLI tasks |

## Security model

- **Allowlist enforced**: only `claude` or `codex` binaries can be spawned. Any other value is rejected.
- **No shell expansion**: arguments are passed as an array via `cross-spawn`, never through a shell.
- **No env injection from server**: the dispatch payload cannot inject environment variables into the subprocess.
- **Ed25519 signature verification**: every `dispatch` message is signed by the LiveMerge server's private key. The daemon verifies against the embedded public key before spawning anything. A hostile WebSocket endpoint impersonating LiveMerge cannot trick the daemon.
- **Backpressure**: only one task runs at a time. A second dispatch while busy is rejected (not queued).

## State file

The daemon persists session state to `~/.livemerge-bridge/state.json`:

```json
{
  "sessionToken": "...",
  "lastRotatedAt": "2026-04-26T00:00:00.000Z",
  "currentTaskRunId": null,
  "seenTaskRunIds": []
}
```

Session tokens rotate every 6 hours automatically. If the daemon is offline for > 24 hours, re-pairing is required.

## Development

```bash
npm install
npm run build   # tsc compile to dist/
npm test        # run vitest (includes 100-cycle daemon-stub integration test)
npm run dev     # tsx watch mode
```

### Running the daemon stub (100-cycle test harness)

```bash
node dist/daemon-stub.js --cycles 100
# 100/100 cycles passed in Xms
```
