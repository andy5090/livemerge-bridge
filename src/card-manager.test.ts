import { describe, expect, it, vi } from 'vitest';
import { CardManager } from './card-manager.js';
import type { ProjectCard } from './project-card.js';

function makeCard(overrides: Partial<ProjectCard> = {}): ProjectCard {
  return {
    project_id: 'my-app-abcd1234',
    branch_basis: 'main',
    stack: 'Node.js, TypeScript',
    module_map: { 'src/': 'daemon' },
    conventions: 'ESLint',
    recent_change_digest: 'feat: x',
    base_commit_sha: 'a'.repeat(40),
    commits_behind: 0,
    status: 'complete',
    is_incomplete: false,
    approved: false,
    ...overrides,
  };
}

function makeManager(opts: {
  card?: ProjectCard;
  approve?: boolean;
  autoApprove?: boolean;
  uploadOk?: boolean;
  headSha?: () => string;
}) {
  const upload = vi.fn().mockResolvedValue({ ok: opts.uploadOk ?? true, status: 200 });
  const build = vi.fn().mockImplementation(() => opts.card ?? makeCard());
  const prompt = vi.fn().mockResolvedValue(opts.approve ?? true);
  const manager = new CardManager({
    projectDir: '/tmp/proj',
    baseUrl: 'https://livemerge.dev',
    getSessionToken: () => 'tok',
    autoApprove: opts.autoApprove ?? false,
    buildImpl: build,
    uploadImpl: upload,
    promptImpl: prompt,
    headShaImpl: () => ({ sha: opts.headSha?.() ?? 'a'.repeat(40), branch: 'main' }),
    watchIntervalMs: 5,
  });
  return { manager, upload, build, prompt };
}

describe('CardManager.start', () => {
  it('prompts for approval and uploads with approved=true when accepted', async () => {
    const { manager, upload, prompt } = makeManager({ approve: true });
    await manager.start();
    manager.stop();
    expect(prompt).toHaveBeenCalledOnce();
    expect(upload).toHaveBeenCalledOnce();
    const sent = upload.mock.calls[0]![0] as ProjectCard;
    expect(sent.approved).toBe(true);
  });

  it('does NOT upload when the member declines', async () => {
    const { manager, upload } = makeManager({ approve: false });
    await manager.start();
    manager.stop();
    expect(upload).not.toHaveBeenCalled();
  });

  it('skips the prompt entirely with autoApprove (headless)', async () => {
    const { manager, upload, prompt } = makeManager({ autoApprove: true });
    await manager.start();
    manager.stop();
    expect(prompt).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledOnce();
  });

  it('never throws when card build fails', async () => {
    const upload = vi.fn();
    const manager = new CardManager({
      projectDir: '/tmp/proj',
      baseUrl: 'https://livemerge.dev',
      getSessionToken: () => 'tok',
      autoApprove: true,
      buildImpl: () => {
        throw new Error('boom');
      },
      uploadImpl: upload,
    });
    await expect(manager.start()).resolves.toBeUndefined();
    expect(upload).not.toHaveBeenCalled();
  });
});

describe('HEAD watcher', () => {
  it('re-uploads when the main SHA moves, and only then', async () => {
    let sha = 'a'.repeat(40);
    const { manager, upload } = makeManager({
      autoApprove: true,
      headSha: () => sha,
    });
    await manager.start();
    expect(upload).toHaveBeenCalledTimes(1);

    // No movement → watcher ticks but never uploads.
    await new Promise((r) => setTimeout(r, 25));
    expect(upload).toHaveBeenCalledTimes(1);

    // HEAD moves → next tick refreshes.
    sha = 'b'.repeat(40);
    await vi.waitFor(() => expect(upload.mock.calls.length).toBeGreaterThan(1));
    manager.stop();
  });
});

describe('refreshRequested (server re-sync)', () => {
  it('forces a re-upload even when SHA is unchanged', async () => {
    const { manager, upload } = makeManager({ autoApprove: true });
    await manager.start();
    manager.stop(); // stop watcher; test the explicit path only
    expect(upload).toHaveBeenCalledTimes(1);
    await manager.refreshRequested();
    expect(upload).toHaveBeenCalledTimes(2);
  });

  it('is a no-op when the member declined the initial approval', async () => {
    const { manager, upload } = makeManager({ approve: false });
    await manager.start();
    manager.stop();
    await manager.refreshRequested();
    expect(upload).not.toHaveBeenCalled();
  });
});
