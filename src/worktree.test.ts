/**
 * Worktree isolation tests — run against a real throwaway git repo.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGitRepo, createTaskWorktree, finalizeTaskWorktree } from './worktree.js';

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

describe('worktree', () => {
  let repo: string;
  let agentDir: string;
  const taskRunId = 'abcd1234-0000-0000-0000-000000000000';

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'lm-repo-'));
    agentDir = mkdtempSync(join(tmpdir(), 'lm-agent-'));
    process.env['LIVEMERGE_AGENT_DIR'] = agentDir;
    git(repo, ['init', '-b', 'main']);
    git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--allow-empty', '-m', 'init']);
  });

  afterEach(() => {
    delete process.env['LIVEMERGE_AGENT_DIR'];
    rmSync(repo, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
  });

  it('detects git repos', () => {
    expect(isGitRepo(repo)).toBe(true);
    expect(isGitRepo(tmpdir())).toBe(false);
  });

  it('creates a worktree on a task branch and commits changes back to it', () => {
    const wt = createTaskWorktree(repo, taskRunId);
    expect(wt).not.toBeNull();
    if (!wt) return;
    expect(wt.branch).toBe('livemerge/task-abcd1234');
    expect(existsSync(wt.dir)).toBe(true);

    writeFileSync(join(wt.dir, 'new-file.ts'), 'export const x = 1;\n');
    const result = finalizeTaskWorktree(repo, wt, taskRunId, 'add new file');

    expect(result.committed).toBe(true);
    // worktree removed, branch retained with the commit
    expect(existsSync(wt.dir)).toBe(false);
    const log = git(repo, ['log', '--oneline', wt.branch]);
    expect(log).toContain('livemerge task abcd1234');
    const files = git(repo, ['show', '--name-only', '--format=', wt.branch]);
    expect(files).toContain('new-file.ts');
  });

  it('deletes the branch when the task produced no changes', () => {
    const wt = createTaskWorktree(repo, taskRunId);
    expect(wt).not.toBeNull();
    if (!wt) return;

    const result = finalizeTaskWorktree(repo, wt, taskRunId, 'noop task');
    expect(result.committed).toBe(false);
    expect(existsSync(wt.dir)).toBe(false);
    const branches = git(repo, ['branch', '--list', wt.branch]);
    expect(branches.trim()).toBe('');
  });

  it('recreates a worktree for a re-dispatched task (stale leftover)', () => {
    const first = createTaskWorktree(repo, taskRunId);
    expect(first).not.toBeNull();
    // simulate crash: worktree left behind, then task re-dispatched
    const second = createTaskWorktree(repo, taskRunId);
    expect(second).not.toBeNull();
    if (!second) return;
    finalizeTaskWorktree(repo, second, taskRunId, 'retry');
  });

  it('returns null when the project dir is not a git repo', () => {
    const notRepo = mkdtempSync(join(tmpdir(), 'lm-notrepo-'));
    try {
      expect(createTaskWorktree(notRepo, taskRunId)).toBeNull();
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });
});
