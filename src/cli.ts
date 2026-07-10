#!/usr/bin/env node
/**
 * CLI entry point for livemerge-bridge.
 * Usage: livemerge-bridge connect <pairingToken> [--project-dir <dir>]
 */

import { Command } from 'commander';
import chalk from 'chalk';
import https from 'node:https';
import http from 'node:http';
import { createRequire } from 'node:module';
import { WsClient } from './ws-client.js';
import { PollingClient } from './polling-client.js';
import { updateState, readState } from './state.js';
import { CardManager } from './card-manager.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const pkg = require('../package.json') as { version: string; description: string };

const program = new Command();

program
  .name('livemerge-bridge')
  .description(pkg.description)
  .version(pkg.version);

program
  .command('connect <pairingToken>')
  .description('Pair with LiveMerge and start the agent daemon')
  .option('-p, --project-dir <dir>', 'Project directory to run CLI tasks in (default: $LIVEMERGE_PROJECT_DIR or cwd)', process.env['LIVEMERGE_PROJECT_DIR'])
  .option('--server-url <url>', 'LiveMerge server URL', 'https://livemerge.dev')
  .option('--no-tui', 'Disable the interactive dashboard (plain log output)')
  .option('--approve-card', 'Approve the project-card upload without the interactive prompt (headless runs)')
  .option('--no-card', 'Disable the project context card entirely')
  .action(async (pairingToken: string, options: { projectDir?: string; serverUrl: string; tui: boolean; approveCard?: boolean; card: boolean }) => {
    const projectDir = options.projectDir ?? process.cwd();
    const serverUrl = options.serverUrl.replace(/\/$/, '');

    console.log(chalk.bold.cyan('LiveMerge Agent'));
    console.log(chalk.gray(`Version: ${pkg.version}`));
    console.log(chalk.gray(`Project dir: ${projectDir}`));
    console.log(chalk.gray(`Server: ${serverUrl}`));
    console.log('');
    console.log(chalk.bold.yellow('⚠  TRUST BOUNDARY'));
    console.log(chalk.yellow('   This daemon will spawn `claude` / `codex` in the project dir above'));
    console.log(chalk.yellow("   based on tasks derived from ANY team member's requests in the paired"));
    console.log(chalk.yellow('   session. Files in that directory may be created, modified, or deleted'));
    console.log(chalk.yellow('   by the agent without per-task confirmation. Pair only on directories'));
    console.log(chalk.yellow('   you trust your team to modify.'));
    console.log('');

    // Step 1: Exchange pairing token for session token + transport URL
    console.log(chalk.cyan('[pair] Exchanging pairing token...'));
    let sessionToken: string;
    let transportUrl: string;
    let serverFeatures: { transport?: string } | undefined;

    try {
      const handshakeResult = await httpGet(
        `${serverUrl}/api/pairing/handshake?token=${encodeURIComponent(pairingToken)}`
      );
      const parsed = JSON.parse(handshakeResult) as {
        sessionToken: string;
        wsUrl: string;
        supportedEnvelopeVersions: number[];
        serverFeatures?: { transport?: string };
      };
      sessionToken = parsed.sessionToken;
      transportUrl = parsed.wsUrl;
      serverFeatures = parsed.serverFeatures;
      console.log(chalk.green('[pair] Pairing successful'));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(chalk.red(`[pair] Handshake failed: ${msg}`));
      console.error(chalk.red('       Check that the pairing token is valid and not expired (TTL: 5 min)'));
      process.exit(1);
    }

    // Persist session token
    updateState({
      sessionToken,
      lastRotatedAt: new Date().toISOString(),
      currentTaskRunId: null,
      seenTaskRunIds: [],
    });

    // Auto-detect transport: http(s) → polling, ws(s) → WebSocket
    const useHttpPolling =
      serverFeatures?.transport === 'http-polling' ||
      transportUrl.startsWith('http://') ||
      transportUrl.startsWith('https://');

    // Project context card lifecycle (initial approval, HEAD watcher,
    // server-requested re-syncs). getSessionToken reads live state so token
    // rotation never strands card uploads with a stale token.
    const cardManager = options.card
      ? new CardManager({
          projectDir,
          baseUrl: serverUrl,
          getSessionToken: () => readState()?.sessionToken ?? sessionToken,
          autoApprove: options.approveCard === true || !process.stdout.isTTY,
        })
      : null;

    const client = useHttpPolling
      ? new PollingClient({
          baseUrl: serverUrl,
          sessionToken,
          projectDir,
          onRevoked: () => {
            console.error(chalk.red('[pair] Pairing revoked. Please re-pair.'));
            process.exit(1);
          },
          onCardRefresh: () => {
            void cardManager?.refreshRequested();
          },
        })
      : new WsClient({
          wsUrl: transportUrl,
          sessionToken,
          projectDir,
          onTokenRotated: (newToken) => {
            console.log(chalk.cyan('[pair] Session token rotated and persisted'));
            updateState({ sessionToken: newToken, lastRotatedAt: new Date().toISOString() });
          },
          onRevoked: () => {
            console.error(chalk.red('[pair] Pairing revoked. Please re-pair.'));
            process.exit(1);
          },
        });

    if (useHttpPolling) {
      console.log(chalk.gray('[pair] Transport: HTTP polling'));
    } else {
      console.log(chalk.gray('[pair] Transport: WebSocket'));
    }

    // Initial card: build → one-time approval (interactive) → upload → HEAD
    // watcher. Must run BEFORE the TUI starts (Ink patches console/stdin, so
    // the readline approval prompt has to happen first). Upload is a direct
    // HTTP call and doesn't need the dispatch client.
    await cardManager?.start();

    // Interactive dashboard — TTY only, opt out with --no-tui. Loaded lazily
    // so headless runs never pay the react/ink import cost. Ink patches
    // console, so the log lines above/below keep working either way.
    let tui: { stop: () => void } | null = null;
    if (options.tui && process.stdout.isTTY) {
      try {
        const { startTui } = await import('./tui.js');
        const { resolveMaxConcurrent } = await import('./polling-client.js');
        tui = startTui({
          version: pkg.version,
          serverUrl,
          projectDir,
          maxConcurrent: resolveMaxConcurrent(),
        });
      } catch (err) {
        console.warn(
          chalk.yellow(
            `[agent] TUI unavailable (${err instanceof Error ? err.message : String(err)}) — falling back to plain logs`,
          ),
        );
      }
    }

    // Graceful shutdown on Ctrl+C
    process.on('SIGINT', () => {
      console.log(chalk.yellow('\n[agent] Shutting down...'));
      tui?.stop();
      cardManager?.stop();
      client.stop();
      process.exit(0);
    });

    process.on('SIGTERM', () => {
      tui?.stop();
      cardManager?.stop();
      client.stop();
      process.exit(0);
    });

    client.start();
    console.log(chalk.green('[agent] Running. Press Ctrl+C to stop.'));
  });

program.parse(process.argv);

// ─── HTTP helper ──────────────────────────────────────────────────────────────

function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('http://') ? http : https;
    const req = lib.get(url, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode ?? 'unknown'}: ${res.statusMessage ?? 'unknown'}`));
        res.resume();
        return;
      }
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(10_000, () => {
      req.destroy(new Error('Request timeout'));
    });
  });
}
