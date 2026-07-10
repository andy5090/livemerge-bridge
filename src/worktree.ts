/**
 * Git worktree isolation for concurrent tasks (hybrid model).
 *
 * The first/primary task keeps running directly in the project directory —
 * identical UX to the serial daemon. Tasks that arrive while the primary slot
 * is busy each get a disposable worktree on a dedicated branch
 * (livemerge/task-<shortid>) created from HEAD. On completion the changes are
 * committed to that branch, the worktree is removed, and the branch name is
 * reported back in callback metadata so the team can review/merge it.
 *
 * All git invocations use execFile (no shell) with an explicit cwd.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const GIT_TIMEOUT_MS = 30_000;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function isGitRepo(dir: string): boolean {
  try {
    return git(dir, ['rev-parse', '--is-inside-work-tree']).trim() === 'true';
  } catch {
    return false;
  }
}

function worktreeBaseDir(): string {
  const agentDir = process.env['LIVEMERGE_AGENT_DIR'] ?? join(homedir(), '.livemerge-bridge');
  return join(agentDir, 'worktrees');
}

export interface TaskWorktree {
  dir: string;
  branch: string;
}

/**
 * Create a worktree + branch for a task, based on the project's current HEAD.
 * Uses -B so a re-dispatched task reuses (resets) its own branch.
 * Returns null when the worktree cannot be created (caller falls back to
 * rejecting the dispatch as busy).
 */
export function createTaskWorktree(projectDir: string, taskRunId: string): TaskWorktree | null {
  const shortId = taskRunId.slice(0, 8);
  const branch = `livemerge/task-${shortId}`;
  const dir = join(worktreeBaseDir(), shortId);
  try {
    mkdirSync(worktreeBaseDir(), { recursive: true });
    if (existsSync(dir)) {
      // stale leftover from a crashed run — remove before re-adding
      git(projectDir, ['worktree', 'remove', '--force', dir]);
    }
    git(projectDir, ['worktree', 'add', '-B', branch, dir, 'HEAD']);
    return { dir, branch };
  } catch (err) {
    console.warn(
      `[worktree] failed to create worktree for ${shortId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

export interface FinalizeResult {
  branch: string;
  /** True when the task produced changes and they were committed to the branch. */
  committed: boolean;
}

/**
 * Commit the task's changes onto its branch (if any), then remove the
 * worktree. An empty run also deletes the branch so no clutter accumulates.
 */
export function finalizeTaskWorktree(
  projectDir: string,
  wt: TaskWorktree,
  taskRunId: string,
  taskDescription: string,
): FinalizeResult {
  let committed = false;
  try {
    const dirty = git(wt.dir, ['status', '--porcelain']).trim().length > 0;
    if (dirty) {
      git(wt.dir, ['add', '-A']);
      git(wt.dir, [
        '-c', 'user.name=LiveMerge Bridge',
        '-c', 'user.email=bridge@livemerge.dev',
        'commit',
        '-m',
        `livemerge task ${taskRunId.slice(0, 8)}: ${taskDescription.slice(0, 72)}`,
      ]);
      committed = true;
    }
  } catch (err) {
    console.warn(
      `[worktree] commit failed for ${wt.branch}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    git(projectDir, ['worktree', 'remove', '--force', wt.dir]);
    if (!committed) {
      git(projectDir, ['branch', '-D', wt.branch]);
    }
  } catch (err) {
    console.warn(
      `[worktree] cleanup failed for ${wt.branch}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return { branch: wt.branch, committed };
}
