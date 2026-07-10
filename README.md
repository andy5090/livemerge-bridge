# livemerge-bridge

CLI daemon that bridges the [LiveMerge](https://livemerge.dev) web app to your local Claude Code or Codex CLI.

## What is LiveMerge?

[LiveMerge](https://livemerge.dev) lets product teams end meetings with **working software, not meeting notes**.

Today, turning a product decision into shipped code means writing a spec, holding a meeting, filing tickets, and waiting a sprint to see whether what comes back matches what you meant. Even when a PM vibe-codes a prototype themselves, it lives outside the team's real codebase — a demo that helps the conversation but never becomes the product.

LiveMerge replaces that round-trip with a **real-time intent layer** between your team and the code:

- **Everyone talks, one graph emerges.** PMs, POs, and developers throw free-text requests into a live session. A **Moderator** AI decomposes them into a single task graph — dependencies, parallel groups, and conflict groups included.
- **Conflicts surface before code exists.** When two requests pull in different directions, an **Arbitrator** AI scores each against the session's reference goal. Soft conflicts get advisory badges; hard ones escalate to the PO with a clear decision.
- **Approved tasks ship immediately.** Accepted tasks are dispatched — cryptographically signed — to a coding agent running on a team member's own machine, in the actual project. Results stream back into the session while the meeting is still going.

Your code never leaves your machine: LiveMerge orchestrates *intent* in the cloud, while all code generation and file access happen locally through this daemon.

PR review? AI does it. Merge conflicts? AI resolves them. Going **PR-less**? *Priceless.*

**This repository is the local half of that loop** — the daemon you run on your machine to receive signed task dispatches and execute them with your own Claude Code or Codex CLI. Anyone on the team who codes with an agent (developers *and* vibe-coding PMs) can pair a bridge.

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
| `LIVEMERGE_TASK_TIMEOUT_MS` | Wall-clock limit per task before the subprocess is killed (default: 1800000 = 30 min) |
| `LIVEMERGE_CLAUDE_PERMISSION_MODE` | `claude --permission-mode` value for headless runs (default: `acceptEdits`) |
| `LIVEMERGE_CODEX_SANDBOX` | `codex --sandbox` value for headless runs (default: `workspace-write`) |
| `LIVEMERGE_MAX_CONCURRENT` | Max concurrent tasks; extra tasks run in isolated git worktrees (default: 3) |

## Concurrency (hybrid worktrees)

The first task runs directly in the project directory, exactly like before.
Tasks that arrive while it's running each get an isolated git worktree on a
`livemerge/task-<id>` branch created from HEAD (up to `LIVEMERGE_MAX_CONCURRENT`
total; beyond that dispatches stay queued server-side). When a worktree task
finishes, its changes are committed to the branch, the worktree is removed,
and the branch name is reported in callback metadata for review/merge. Empty
runs delete their branch. Non-git project dirs fall back to serial behavior.

## Dashboard (TUI)

When run in a terminal, the daemon shows a live dashboard: connection status,
running tasks with agent, elapsed time, live activity (tool calls, file edits),
turn count, and cost. Dispatch banners and completion lines scroll above it.
Pass `--no-tui` (or pipe output) for plain log mode.

## Headless invocation defaults

Tasks run non-interactively, so the daemon applies flags that would otherwise
leave the agent unable to act (permission prompts auto-deny in headless mode):

- `claude` → `--print --output-format stream-json --verbose --permission-mode acceptEdits <prompt>`
- `codex` → `exec --json --sandbox workspace-write --ask-for-approval never <prompt>`

Server-supplied `cliArgs` can override any default (e.g. `--model`,
`--permission-mode`, `--sandbox`). A `--resume <sessionId>` arg is translated
per binary (`claude --resume <id>` / `codex exec resume <id>`) so a retry can
continue the previous agent session. Structured stdout is parsed for the
session id, token usage, cost, and final message, which are reported back in
the callback `metadata`.

## Security model

- **Allowlist enforced**: only `claude` or `codex` binaries can be spawned. Any other value is rejected.
- **No shell expansion**: arguments are passed as an array via `cross-spawn`, never through a shell.
- **No env injection from server**: the dispatch payload cannot inject environment variables into the subprocess.
- **Ed25519 signature verification with key rotation**: every `dispatch` message is signed by the server's dispatch key and carries a `kid`. The daemon resolves the key from a signed key set fetched at `GET /api/codewriter/jwks`, verified against a **root public key embedded in this package** — so a hostile server cannot inject its own keys, and dispatch keys can be rotated (or revoked after a leak) without an npm release. The last verified set is cached on disk for offline resilience.
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
