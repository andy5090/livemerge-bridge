/**
 * Project-card lifecycle manager for the bridge daemon.
 *
 * Owns the three refresh triggers decided in the card spec:
 *   1. connect time (initial card, one-time member approval before upload),
 *   2. local git HEAD movement (covers out-of-band commits — polled),
 *   3. server-requested re-sync (session start / manual button, delivered as
 *      a `card-refresh` envelope over the existing dispatch transport).
 *
 * Every upload passes the fixed redaction policy. A refresh only uploads
 * when the main-branch SHA actually moved (or when forced by the server),
 * so idle projects generate no traffic.
 */

import chalk from 'chalk';
import readline from 'node:readline';
import {
  buildProjectCard,
  getMainBranchSha,
  uploadProjectCard,
  type ProjectCard,
  type UploadProjectCardResult,
} from './project-card.js';
import { redactCard } from './card-redaction.js';

export const HEAD_WATCH_INTERVAL_MS = 60_000;

export interface CardManagerOptions {
  projectDir: string;
  baseUrl: string;
  /** Read the CURRENT session token (it rotates). */
  getSessionToken: () => string;
  /** Non-TTY / --approve-card runs skip the interactive prompt. */
  autoApprove?: boolean;
  watchIntervalMs?: number;
  /** Injected in tests. */
  buildImpl?: typeof buildProjectCard;
  uploadImpl?: (
    card: ProjectCard,
    opts: { baseUrl: string; sessionToken: string },
  ) => Promise<UploadProjectCardResult>;
  promptImpl?: (question: string) => Promise<boolean>;
  headShaImpl?: typeof getMainBranchSha;
}

function summarizeCard(card: ProjectCard): string {
  const modules = card.module_map
    ? Object.entries(card.module_map)
        .slice(0, 8)
        .map(([dir, desc]) => `    ${dir} — ${desc}`)
        .join('\n')
    : '    (none)';
  return [
    `  project:     ${card.project_id} (${card.branch_basis})`,
    `  base commit: ${card.base_commit_sha ?? '(unknown)'}`,
    `  stack:       ${card.stack ?? '(unknown)'}`,
    `  modules:`,
    modules,
    `  conventions: ${(card.conventions ?? '(unknown)').slice(0, 200)}`,
    `  recent:      ${(card.recent_change_digest ?? '(unknown)').slice(0, 200)}`,
    `  status:      ${card.status}`,
  ].join('\n');
}

function ttyPrompt(question: string): Promise<boolean> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

export class CardManager {
  private readonly opts: CardManagerOptions;
  private lastUploadedSha: string | null = null;
  private approved = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshing = false;

  constructor(opts: CardManagerOptions) {
    this.opts = opts;
  }

  /**
   * Initial build → (one-time approval) → upload → start HEAD watcher.
   * Never throws: card failures must not take the dispatch daemon down.
   */
  async start(): Promise<void> {
    try {
      const build = this.opts.buildImpl ?? buildProjectCard;
      const card = redactCard(build(this.opts.projectDir));

      if (this.opts.autoApprove) {
        this.approved = true;
      } else {
        console.log('');
        console.log(chalk.bold.cyan('[card] Project context card (first upload needs your approval)'));
        console.log(chalk.gray('       Only this summary travels — never your code.'));
        console.log(summarizeCard(card));
        const prompt = this.opts.promptImpl ?? ttyPrompt;
        this.approved = await prompt(
          chalk.bold('[card] Upload this card to the session? (y/N) '),
        );
      }

      if (!this.approved) {
        console.log(
          chalk.yellow(
            '[card] Skipped. The Moderator will derive tasks without project context. Re-run connect to approve later.',
          ),
        );
        return;
      }

      await this.uploadCard({ ...card, approved: true }, 'initial');
      this.startWatcher();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(chalk.yellow(`[card] Initial card generation failed: ${msg}`));
    }
  }

  /** Server-requested re-sync (session start / manual button). */
  async refreshRequested(): Promise<void> {
    if (!this.approved) return; // never auto-upload past a declined approval
    await this.refresh(true, 'server request');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private startWatcher(): void {
    const interval = this.opts.watchIntervalMs ?? HEAD_WATCH_INTERVAL_MS;
    this.timer = setInterval(() => {
      void this.refresh(false, 'git change');
    }, interval);
    this.timer.unref?.();
  }

  /** Rebuild + upload. Skips when main SHA hasn't moved (unless forced). */
  private async refresh(force: boolean, reason: string): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const headSha = (this.opts.headShaImpl ?? getMainBranchSha)(
        this.opts.projectDir,
      ).sha;
      if (!force && (headSha === '' || headSha === this.lastUploadedSha)) {
        return;
      }
      const build = this.opts.buildImpl ?? buildProjectCard;
      const card = redactCard(build(this.opts.projectDir));
      await this.uploadCard({ ...card, approved: true }, reason);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(chalk.yellow(`[card] Refresh failed (${reason}): ${msg}`));
    } finally {
      this.refreshing = false;
    }
  }

  private async uploadCard(card: ProjectCard, reason: string): Promise<void> {
    const upload = this.opts.uploadImpl ?? uploadProjectCard;
    const result = await upload(card, {
      baseUrl: this.opts.baseUrl,
      sessionToken: this.opts.getSessionToken(),
    });
    if (result.ok) {
      this.lastUploadedSha = card.base_commit_sha;
      console.log(
        chalk.green(
          `[card] Uploaded (${reason}) — as of ${card.base_commit_sha?.slice(0, 8) ?? 'unknown'}${card.is_incomplete ? ' · incomplete' : ''}`,
        ),
      );
    } else {
      console.warn(
        chalk.yellow(
          `[card] Upload failed (${reason}): ${result.error ?? `HTTP ${result.status ?? '?'}`}`,
        ),
      );
    }
  }
}
