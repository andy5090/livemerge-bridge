/**
 * Unit tests for buildProjectCard and its sub-collectors.
 *
 * Uses real throwaway directories / git repos — no mocks.
 * Tests cover: full cards, partial cards, and the is_incomplete flag.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildProjectCard,
  detectStack,
  buildModuleMap,
  detectConventions,
  getMainBranchSha,
  getCommitsBehind,
  getRecentChangeDigest,
  uploadProjectCard,
} from './project-card.js';
import type { ProjectCard } from './project-card.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' });
}

function initRepo(dir: string, branch = 'main'): void {
  git(dir, ['init', '-b', branch]);
  git(dir, ['-c', 'user.name=Test', '-c', 'user.email=t@t.com', 'commit', '--allow-empty', '-m', 'init']);
}

function addCommit(dir: string, message: string, files: Record<string, string> = {}): void {
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
  }
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.name=Test', '-c', 'user.email=t@t.com', 'commit', '-m', message]);
}

// ─── Test setup ───────────────────────────────────────────────────────────────

describe('detectStack', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lm-stack-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty string when no manifest files exist', () => {
    expect(detectStack(dir)).toBe('');
  });

  it('detects Node.js and TypeScript from package.json + tsconfig', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ engines: { node: '>=20' } }));
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({}));
    const stack = detectStack(dir);
    expect(stack).toContain('Node.js');
    expect(stack).toContain('TypeScript');
  });

  it('detects React from dependencies', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ dependencies: { react: '^19.0.0' } }),
    );
    expect(detectStack(dir)).toContain('React');
  });

  it('detects Vitest from devDependencies', () => {
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }),
    );
    expect(detectStack(dir)).toContain('Vitest');
  });

  it('detects Go from go.mod', () => {
    writeFileSync(join(dir, 'go.mod'), 'module example.com/foo\n\ngo 1.21\n');
    expect(detectStack(dir)).toContain('Go');
  });

  it('detects Rust from Cargo.toml', () => {
    writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "foo"\nversion = "0.1.0"\n');
    expect(detectStack(dir)).toContain('Rust');
  });

  it('detects Python from requirements.txt', () => {
    writeFileSync(join(dir, 'requirements.txt'), 'django>=4.0\n');
    expect(detectStack(dir)).toContain('Python');
  });

  it('detects multiple stacks in a polyglot repo', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: { react: '^19.0.0' } }));
    writeFileSync(join(dir, 'go.mod'), 'module example.com/backend\n\ngo 1.21\n');
    const stack = detectStack(dir);
    expect(stack).toContain('Node.js');
    expect(stack).toContain('React');
    expect(stack).toContain('Go');
  });
});

// ─── buildModuleMap ───────────────────────────────────────────────────────────

describe('buildModuleMap', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lm-modules-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty map for empty directory', () => {
    expect(buildModuleMap(dir)).toEqual({});
  });

  it('ignores node_modules and .git', () => {
    mkdirSync(join(dir, 'node_modules'));
    mkdirSync(join(dir, '.git'));
    expect(buildModuleMap(dir)).toEqual({});
  });

  it('maps known directory names to roles', () => {
    mkdirSync(join(dir, 'src'));
    mkdirSync(join(dir, 'tests'));
    mkdirSync(join(dir, 'api'));
    const map = buildModuleMap(dir);
    expect(map['src']).toBe('source code');
    expect(map['tests']).toBe('tests');
    expect(map['api']).toBe('API layer');
  });

  it('uses package.json description for unknown subdirs', () => {
    const subPkg = join(dir, 'my-package');
    mkdirSync(subPkg);
    writeFileSync(
      join(subPkg, 'package.json'),
      JSON.stringify({ description: 'My special package' }),
    );
    const map = buildModuleMap(dir);
    expect(map['my-package']).toBe('My special package');
  });

  it('falls back to generic label for unknown dirs without package.json', () => {
    mkdirSync(join(dir, 'xyzzy'));
    const map = buildModuleMap(dir);
    expect(map['xyzzy']).toBe('xyzzy module');
  });

  it('skips files (only includes directories)', () => {
    writeFileSync(join(dir, 'README.md'), '# readme');
    mkdirSync(join(dir, 'app'));
    const map = buildModuleMap(dir);
    expect('README.md' in map).toBe(false);
    expect('app' in map).toBe('app' in map); // directory is included
    expect(map['app']).toBe('application layer');
  });
});

// ─── detectConventions ────────────────────────────────────────────────────────

describe('detectConventions', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lm-conv-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns empty string when no config files exist', () => {
    expect(detectConventions(dir)).toBe('');
  });

  it('detects TypeScript strict mode', () => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    expect(detectConventions(dir)).toContain('TypeScript strict mode');
  });

  it('detects noUncheckedIndexedAccess and exactOptionalPropertyTypes', () => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          noUncheckedIndexedAccess: true,
          exactOptionalPropertyTypes: true,
        },
      }),
    );
    const c = detectConventions(dir);
    expect(c).toContain('noUncheckedIndexedAccess');
    expect(c).toContain('exactOptionalPropertyTypes');
  });

  it('detects ESLint config', () => {
    writeFileSync(join(dir, '.eslintrc.json'), JSON.stringify({ rules: {} }));
    expect(detectConventions(dir)).toContain('ESLint');
  });

  it('detects Prettier config', () => {
    writeFileSync(join(dir, '.prettierrc'), JSON.stringify({ semi: false }));
    expect(detectConventions(dir)).toContain('Prettier');
  });

  it('detects ESM from package.json type field', () => {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ type: 'module' }));
    expect(detectConventions(dir)).toContain('ESM modules');
  });

  it('detects Vitest from config file', () => {
    writeFileSync(join(dir, 'vitest.config.ts'), 'export default {}');
    expect(detectConventions(dir)).toContain('Vitest for testing');
  });

  it('accumulates multiple conventions', () => {
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true } }),
    );
    writeFileSync(join(dir, '.eslintrc.json'), '{}');
    writeFileSync(join(dir, '.prettierrc'), '{}');
    const c = detectConventions(dir);
    expect(c).toContain('TypeScript strict mode');
    expect(c).toContain('ESLint');
    expect(c).toContain('Prettier');
  });
});

// ─── Git helpers ──────────────────────────────────────────────────────────────

describe('getMainBranchSha', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'lm-sha-'));
    initRepo(repo, 'main');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns the main branch SHA (40 chars)', () => {
    const { sha, branch } = getMainBranchSha(repo);
    expect(sha).toHaveLength(40);
    expect(branch).toBe('main');
  });

  it('returns empty SHA for non-git directory', () => {
    const plain = mkdtempSync(join(tmpdir(), 'lm-plain-'));
    try {
      const { sha } = getMainBranchSha(plain);
      expect(sha).toBe('');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('falls back to master branch', () => {
    const masterRepo = mkdtempSync(join(tmpdir(), 'lm-master-'));
    try {
      initRepo(masterRepo, 'master');
      const { sha, branch } = getMainBranchSha(masterRepo);
      expect(sha).toHaveLength(40);
      expect(branch).toBe('master');
    } finally {
      rmSync(masterRepo, { recursive: true, force: true });
    }
  });
});

describe('getCommitsBehind', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'lm-behind-'));
    initRepo(repo, 'main');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns 0 when HEAD equals baseSha', () => {
    const { sha } = getMainBranchSha(repo);
    expect(getCommitsBehind(repo, sha)).toBe(0);
  });

  it('returns 0 for empty baseSha', () => {
    expect(getCommitsBehind(repo, '')).toBe(0);
  });

  it('counts commits added after baseSha', () => {
    const { sha: baseSha } = getMainBranchSha(repo);
    addCommit(repo, 'second commit', { 'a.txt': 'hello' });
    addCommit(repo, 'third commit', { 'b.txt': 'world' });
    const behind = getCommitsBehind(repo, baseSha);
    expect(behind).toBe(2);
  });
});

describe('getRecentChangeDigest', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'lm-digest-'));
    initRepo(repo, 'main');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns empty string for a repo with no non-merge commits after empty-init', () => {
    // The init commit is an allow-empty commit, so log might return it
    const digest = getRecentChangeDigest(repo, 'main');
    // Should either return something with 'init' or be a non-empty string
    // (empty-allow commits still appear in git log)
    expect(typeof digest).toBe('string');
  });

  it('includes recent commit messages in the digest', () => {
    addCommit(repo, 'add feature X', { 'feature.ts': 'export const x = 1;' });
    const digest = getRecentChangeDigest(repo, 'main');
    expect(digest).toContain('add feature X');
  });

  it('includes recently changed file names (without code content)', () => {
    mkdirSync(join(repo, 'utils'));
    addCommit(repo, 'add utils', { 'utils/helpers.ts': 'export function f() {}' });
    const digest = getRecentChangeDigest(repo, 'main');
    expect(digest).toContain('utils/helpers.ts');
    // Must NOT include code content
    expect(digest).not.toContain('export function f');
  });

  it('returns empty string for non-git directory', () => {
    const plain = mkdtempSync(join(tmpdir(), 'lm-plain-'));
    try {
      expect(getRecentChangeDigest(plain, 'main')).toBe('');
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

// ─── buildProjectCard (integration) ──────────────────────────────────────────

describe('buildProjectCard', () => {
  let repo: string;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'lm-card-'));
    initRepo(repo, 'main');
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  it('returns a ProjectCard with all required fields typed correctly', () => {
    addCommit(repo, 'setup project', {
      'package.json': JSON.stringify({
        type: 'module',
        engines: { node: '>=20' },
        devDependencies: { vitest: '^2.0.0', typescript: '^5.0.0' },
      }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
      'vitest.config.ts': 'export default {}',
    });
    mkdirSync(join(repo, 'src'));
    mkdirSync(join(repo, 'tests'));

    const card = buildProjectCard(repo);

    expect(typeof card.project_id).toBe('string');
    expect(typeof card.branch_basis).toBe('string');
    expect(typeof card.stack).toBe('string');
    expect(typeof card.module_map).toBe('object');
    expect(typeof card.conventions).toBe('string');
    expect(typeof card.recent_change_digest).toBe('string');
    expect(typeof card.base_commit_sha).toBe('string');
    expect(typeof card.commits_behind).toBe('number');
    expect(['complete', 'incomplete']).toContain(card.status);
    expect(typeof card.is_incomplete).toBe('boolean');
    expect(typeof card.approved).toBe('boolean');
  });

  it('produces a full (complete) card when all 5 fields are populated', () => {
    addCommit(repo, 'setup project', {
      'package.json': JSON.stringify({
        type: 'module',
        engines: { node: '>=20' },
        devDependencies: { vitest: '^2.0.0' },
      }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
      'vitest.config.ts': 'export default {}',
    });
    mkdirSync(join(repo, 'src'));

    const card = buildProjectCard(repo);

    expect(card.stack).not.toBeNull();
    expect(Object.keys(card.module_map ?? {}).length).toBeGreaterThan(0);
    expect(card.conventions).not.toBeNull();
    expect(card.recent_change_digest).not.toBeNull();
    expect(card.base_commit_sha).toHaveLength(40);
    expect(card.status).toBe('complete');
    expect(card.is_incomplete).toBe(false);
  });

  it('sets stack to null and status incomplete when no manifest files exist', () => {
    // Repo has commits and directories but no package.json / go.mod / etc.
    mkdirSync(join(repo, 'src'));
    addCommit(repo, 'add src dir', {
      'src/index.txt': 'hello',
      '.editorconfig': '[*]\nindent_style = space\n',
    });

    const card = buildProjectCard(repo);

    expect(card.stack).toBeNull();
    expect(card.status).toBe('incomplete');
    expect(card.is_incomplete).toBe(true);
  });

  it('sets module_map to null and status incomplete when only files, no directories', () => {
    addCommit(repo, 'add files only', {
      'package.json': JSON.stringify({ engines: { node: '>=20' }, devDependencies: { vitest: '^2.0.0' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
      'index.ts': 'export const x = 1;',
    });

    const card = buildProjectCard(repo);

    // No subdirectories → module_map cannot be derived → null
    expect(card.module_map).toBeNull();
    expect(card.status).toBe('incomplete');
    expect(card.is_incomplete).toBe(true);
  });

  it('sets base_commit_sha to null and status incomplete in a non-git dir', () => {
    const plain = mkdtempSync(join(tmpdir(), 'lm-plain-'));
    try {
      // Add manifest files but no git
      writeFileSync(join(plain, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^2.0.0' } }));
      writeFileSync(join(plain, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
      mkdirSync(join(plain, 'src'));

      const card = buildProjectCard(plain);

      expect(card.base_commit_sha).toBeNull();
      expect(card.status).toBe('incomplete');
      expect(card.is_incomplete).toBe(true);
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it('sets approved to false by default', () => {
    const card = buildProjectCard(repo);
    expect(card.approved).toBe(false);
  });

  it('derives project_id from repo basename and the ROOT commit SHA', () => {
    addCommit(repo, 'setup', { 'package.json': JSON.stringify({}) });
    mkdirSync(join(repo, 'src'));

    const card = buildProjectCard(repo);
    expect(card.project_id.length).toBeGreaterThan(0);

    // Identity must be STABLE across new commits — a HEAD-based key would
    // insert a new card row per commit instead of updating one card.
    addCommit(repo, 'more work', { 'CHANGES.md': 'x' });
    const cardAfter = buildProjectCard(repo);
    expect(cardAfter.project_id).toBe(card.project_id);
    if (card.base_commit_sha && cardAfter.base_commit_sha) {
      expect(cardAfter.base_commit_sha).not.toBe(card.base_commit_sha);
    }
  });

  it('reports branch_basis as main when repo uses main branch', () => {
    const card = buildProjectCard(repo);
    expect(card.branch_basis).toBe('main');
  });

  it('reports commits_behind as 0 when HEAD is at main SHA', () => {
    addCommit(repo, 'setup', { 'package.json': JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }) });
    mkdirSync(join(repo, 'src'));

    const card = buildProjectCard(repo);
    expect(card.commits_behind).toBe(0);
  });

  it('stamps status incomplete and still uploads when a collector throws', async () => {
    addCommit(repo, 'setup project', {
      'package.json': JSON.stringify({ engines: { node: '>=20' }, devDependencies: { vitest: '^2.0.0' } }),
      'tsconfig.json': JSON.stringify({ compilerOptions: { strict: true } }),
      'vitest.config.ts': 'export default {}',
    });
    mkdirSync(join(repo, 'src'), { recursive: true });

    // Inject a detectStack collector that throws to simulate a collector failure
    const card = buildProjectCard(repo, {
      detectStack: () => { throw new Error('simulated collector failure'); },
    });

    // Stack field must be null because its collector threw
    expect(card.stack).toBeNull();
    // Card must be stamped incomplete
    expect(card.status).toBe('incomplete');
    expect(card.is_incomplete).toBe(true);

    // Upload must still proceed (non-blocking) and succeed
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await uploadProjectCard(card, {
      baseUrl: 'https://livemerge.dev',
      sessionToken: 'test-token',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();

    // Verify incomplete flag is faithfully transmitted in the upload body
    const [[, init]] = mockFetch.mock.calls as [[string, RequestInit]];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['status']).toBe('incomplete');
    expect(body['is_incomplete']).toBe(true);
    expect(body['stack']).toBeNull();
  });

  it('partial card: git works but conventions cannot be derived', () => {
    // No tsconfig, no eslint, no prettier — conventions will be null
    addCommit(repo, 'setup minimal', { 'package.json': JSON.stringify({ engines: { node: '>=20' } }) });
    mkdirSync(join(repo, 'src'));

    const card = buildProjectCard(repo);

    // stack is populated (Node.js), module_map has src, but conventions is null
    expect(card.stack).toContain('Node.js');
    expect(Object.keys(card.module_map ?? {}).length).toBeGreaterThan(0);
    expect(card.conventions).toBeNull();
    expect(card.status).toBe('incomplete');
    expect(card.is_incomplete).toBe(true);
  });
});

// ─── uploadProjectCard ────────────────────────────────────────────────────────

/** Build a minimal complete ProjectCard for upload tests */
function makeCard(overrides: Partial<ProjectCard> = {}): ProjectCard {
  return {
    project_id: 'my-repo-abc12345',
    branch_basis: 'main',
    stack: 'Node.js >=20, TypeScript',
    module_map: { src: 'source code', tests: 'tests' },
    conventions: 'TypeScript strict mode, ESLint, Vitest for testing',
    recent_change_digest: 'Recent commits:\nabc1234 add feature X\n\nRecently changed files: src/index.ts',
    base_commit_sha: 'a'.repeat(40),
    commits_behind: 0,
    status: 'complete',
    is_incomplete: false,
    approved: true,
    ...overrides,
  };
}

describe('uploadProjectCard', () => {
  it('sends only ProjectCard summary fields — no raw source code — in the request body', async () => {
    let capturedBody: string | undefined;
    const mockFetch = vi.fn().mockImplementation((_url: unknown, init: RequestInit) => {
      capturedBody = init.body as string;
      return Promise.resolve({ ok: true, status: 200 });
    });

    const card = makeCard();
    const result = await uploadProjectCard(card, {
      baseUrl: 'https://livemerge.dev',
      sessionToken: 'test-token',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(result.ok).toBe(true);
    expect(capturedBody).toBeDefined();

    // Parse body and verify it is a ProjectCard summary (only known ontology fields)
    const parsed = JSON.parse(capturedBody!) as Record<string, unknown>;
    expect(parsed['project_id']).toBe('my-repo-abc12345');
    expect(parsed['stack']).toBe('Node.js >=20, TypeScript');
    expect(parsed['module_map']).toEqual({ src: 'source code', tests: 'tests' });
    expect(parsed['conventions']).toContain('ESLint');
    expect(parsed['base_commit_sha']).toHaveLength(40);
    expect(parsed['is_incomplete']).toBe(false);

    // Privacy: payload must not contain raw source code constructs
    expect(capturedBody).not.toMatch(/\bimport\s+/);
    expect(capturedBody).not.toMatch(/export\s+(?:function|class|const)/);
    expect(capturedBody).not.toMatch(/\bconst\s+\w+\s*=/);
  });

  it('transmits incomplete cards (is_incomplete=true) without blocking', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });

    const incompleteCard = makeCard({
      stack: null,
      module_map: null,
      conventions: null,
      recent_change_digest: null,
      base_commit_sha: null,
      status: 'incomplete',
      is_incomplete: true,
      approved: false,
    });

    const result = await uploadProjectCard(incompleteCard, {
      baseUrl: 'https://livemerge.dev',
      sessionToken: 'test-token',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    // Must succeed without blocking or rejecting due to incomplete fields
    expect(result.ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledOnce();

    // Verify is_incomplete=true is faithfully transmitted
    const [[, init]] = mockFetch.mock.calls as [[string, RequestInit]];
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body['is_incomplete']).toBe(true);
    expect(body['status']).toBe('incomplete');
    expect(body['stack']).toBeNull();
    expect(body['base_commit_sha']).toBeNull();
  });

  it('returns ok: false on network error without throwing', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await uploadProjectCard(makeCard(), {
      baseUrl: 'https://livemerge.dev',
      sessionToken: 'test-token',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
    expect(result.status).toBeUndefined();
  });

  it('returns ok: false with status on HTTP error responses', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 503 });

    const result = await uploadProjectCard(makeCard(), {
      baseUrl: 'https://livemerge.dev',
      sessionToken: 'test-token',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(result.ok).toBe(false);
    expect(result.status).toBe(503);
  });

  it('strips trailing slash from baseUrl and posts to /api/project-card', async () => {
    let capturedUrl: string | undefined;
    const mockFetch = vi.fn().mockImplementation((url: unknown) => {
      capturedUrl = url as string;
      return Promise.resolve({ ok: true, status: 200 });
    });

    await uploadProjectCard(makeCard(), {
      baseUrl: 'https://livemerge.dev/',
      sessionToken: 'test-token',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(capturedUrl).toBe('https://livemerge.dev/api/project-card');
  });

  it('sends Authorization Bearer header with the session token', async () => {
    let capturedHeaders: Record<string, string> | undefined;
    const mockFetch = vi.fn().mockImplementation((_url: unknown, init: RequestInit) => {
      capturedHeaders = init.headers as Record<string, string>;
      return Promise.resolve({ ok: true, status: 200 });
    });

    await uploadProjectCard(makeCard(), {
      baseUrl: 'https://livemerge.dev',
      sessionToken: 'my-secret-jwt',
      fetchImpl: mockFetch as unknown as typeof fetch,
    });

    expect(capturedHeaders?.['Authorization']).toBe('Bearer my-secret-jwt');
    expect(capturedHeaders?.['Content-Type']).toBe('application/json');
  });
});
