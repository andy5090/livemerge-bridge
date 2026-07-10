/**
 * ProjectCard builder — collects a privacy-preserving summary of a project's
 * main-branch state from the local filesystem and git. No code content ever
 * leaves the machine; only the 5-field summary (stack, module-map, conventions,
 * recent-change digest, base-commit SHA) is produced here.
 *
 * Designed for the bridge: runs locally, git-only, no network calls.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A lightweight, privacy-preserving summary of a brownfield project's
 * main-branch reality. All five required fields must be non-empty for the
 * card to be considered complete.
 */
export type ProjectCardStatus = 'complete' | 'incomplete';

export interface ProjectCard {
  /** Identifier: "{repo-basename}-{sha8}" */
  project_id: string;
  /** Branch the card represents — 'main' or 'master' */
  branch_basis: string;
  /** Languages, frameworks and runtimes detected — null when none derivable */
  stack: string | null;
  /** Per-directory responsibilities — null when no modules derivable */
  module_map: Record<string, string> | null;
  /** Coding conventions detected from config files — null when none derivable */
  conventions: string | null;
  /** Digest of recent changes — null when git history is unavailable */
  recent_change_digest: string | null;
  /** Main-branch commit SHA the card was generated against — null outside git */
  base_commit_sha: string | null;
  /** Number of commits the current HEAD is ahead of base_commit_sha */
  commits_behind: number;
  /** 'incomplete' when any of the 5 required fields is null, else 'complete' */
  status: ProjectCardStatus;
  /** True when any of the 5 required fields is null (mirrors status) */
  is_incomplete: boolean;
  /** Whether the first upload received one-time member approval */
  approved: boolean;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const GIT_TIMEOUT_MS = 15_000;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function tryGit(cwd: string, args: string[]): string {
  try {
    return git(cwd, args).trim();
  } catch {
    return '';
  }
}

function readFileSafe(path: string): string {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return '';
  }
}

function parseJsonSafe(content: string): Record<string, unknown> | null {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// ─── Stack detection ─────────────────────────────────────────────────────────

/**
 * Infers the technology stack from manifest files found in the project root.
 * No file contents beyond manifest metadata are read.
 */
export function detectStack(projectPath: string): string {
  const parts: string[] = [];

  // Node.js / JavaScript / TypeScript
  const pkgJson = readFileSafe(join(projectPath, 'package.json'));
  if (pkgJson) {
    const pkg = parseJsonSafe(pkgJson);
    if (pkg) {
      const engines = pkg['engines'] as Record<string, string> | undefined;
      const nodeVer = engines?.['node'] ?? '';
      parts.push(`Node.js${nodeVer ? ' ' + nodeVer : ''}`);

      const allDeps = {
        ...((pkg['dependencies'] as Record<string, string>) ?? {}),
        ...((pkg['devDependencies'] as Record<string, string>) ?? {}),
      };

      if (existsSync(join(projectPath, 'tsconfig.json'))) {
        parts.push('TypeScript');
      }

      // Frameworks
      if ('react' in allDeps) parts.push('React');
      if ('next' in allDeps) parts.push('Next.js');
      if ('vue' in allDeps) parts.push('Vue');
      if ('svelte' in allDeps) parts.push('Svelte');
      if ('express' in allDeps) parts.push('Express');
      if ('fastify' in allDeps) parts.push('Fastify');
      if ('react-router' in allDeps) parts.push('React Router');
      if ('hono' in allDeps) parts.push('Hono');

      // Databases
      if ('drizzle-orm' in allDeps) parts.push('Drizzle ORM');
      if ('prisma' in allDeps || '@prisma/client' in allDeps) parts.push('Prisma');
      if ('typeorm' in allDeps) parts.push('TypeORM');

      // Test frameworks
      if ('vitest' in allDeps) parts.push('Vitest');
      if ('jest' in allDeps) parts.push('Jest');
    }
  }

  // Python
  if (existsSync(join(projectPath, 'pyproject.toml'))) {
    parts.push('Python');
    const pyproj = readFileSafe(join(projectPath, 'pyproject.toml'));
    if (pyproj.includes('django')) parts.push('Django');
    if (pyproj.includes('fastapi')) parts.push('FastAPI');
    if (pyproj.includes('flask')) parts.push('Flask');
  } else if (existsSync(join(projectPath, 'requirements.txt'))) {
    parts.push('Python');
  }

  // Go
  if (existsSync(join(projectPath, 'go.mod'))) {
    parts.push('Go');
  }

  // Rust
  if (existsSync(join(projectPath, 'Cargo.toml'))) {
    parts.push('Rust');
  }

  // Java / Kotlin
  if (existsSync(join(projectPath, 'pom.xml'))) {
    parts.push('Java (Maven)');
  }
  if (existsSync(join(projectPath, 'build.gradle')) || existsSync(join(projectPath, 'build.gradle.kts'))) {
    parts.push('JVM (Gradle)');
  }

  return [...new Set(parts)].join(', ');
}

// ─── Module map ───────────────────────────────────────────────────────────────

/** Well-known directory names → human-readable role */
const DIR_ROLE_MAP: Record<string, string> = {
  src: 'source code',
  app: 'application layer',
  lib: 'shared library utilities',
  libs: 'shared library utilities',
  packages: 'monorepo packages',
  components: 'UI components',
  pages: 'page-level components',
  routes: 'route definitions',
  api: 'API layer',
  server: 'server-side code',
  client: 'client-side code',
  hooks: 'React hooks',
  utils: 'utility functions',
  helpers: 'helper functions',
  services: 'business logic services',
  models: 'data models',
  schema: 'schema definitions',
  db: 'database layer',
  database: 'database layer',
  drizzle: 'Drizzle ORM migrations and schema',
  migrations: 'database migrations',
  config: 'configuration',
  configs: 'configuration',
  scripts: 'build and utility scripts',
  docs: 'documentation',
  public: 'static assets',
  assets: 'static assets',
  styles: 'stylesheets',
  css: 'stylesheets',
  test: 'tests',
  tests: 'tests',
  spec: 'test specifications',
  '__tests__': 'tests',
  e2e: 'end-to-end tests',
  fixtures: 'test fixtures',
  mocks: 'test mocks',
  features: 'feature modules',
  store: 'state management',
  state: 'state management',
  context: 'React context providers',
  types: 'TypeScript type definitions',
  interfaces: 'TypeScript interfaces',
  middleware: 'middleware',
  plugins: 'plugins',
  common: 'shared/common code',
  shared: 'shared code',
  core: 'core application logic',
  infra: 'infrastructure code',
  deploy: 'deployment configuration',
  supabase: 'Supabase configuration and migrations',
  prisma: 'Prisma schema and migrations',
};

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.github',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'out',
  'coverage',
  '.turbo',
  '.cache',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
  '.vscode',
  '.DS_Store',
]);

/**
 * Builds a module map by scanning top-level directories and inferring their
 * roles from naming conventions. Never reads file contents.
 */
export function buildModuleMap(projectPath: string): Record<string, string> {
  const map: Record<string, string> = {};

  let entries: string[];
  try {
    entries = readdirSync(projectPath);
  } catch {
    return map;
  }

  for (const entry of entries) {
    if (IGNORE_DIRS.has(entry) || entry.startsWith('.')) continue;
    try {
      const fullPath = join(projectPath, entry);
      const stat = statSync(fullPath);
      if (!stat.isDirectory()) continue;

      const role = DIR_ROLE_MAP[entry.toLowerCase()] ?? inferRoleFromPackageJson(fullPath) ?? `${entry} module`;
      map[entry] = role;
    } catch {
      // skip unreadable entries
    }
  }

  return map;
}

/** Reads package.json description from a subdirectory for richer module names */
function inferRoleFromPackageJson(dirPath: string): string | null {
  const pkgPath = join(dirPath, 'package.json');
  if (!existsSync(pkgPath)) return null;
  const pkg = parseJsonSafe(readFileSafe(pkgPath));
  if (!pkg) return null;
  const desc = pkg['description'];
  if (typeof desc === 'string' && desc.length > 0) return desc;
  const name = pkg['name'];
  if (typeof name === 'string' && name.length > 0) return `${name} package`;
  return null;
}

// ─── Conventions detection ───────────────────────────────────────────────────

/**
 * Detects coding conventions from config files in the project root.
 * Reads only config file names and top-level settings — never source code.
 */
export function detectConventions(projectPath: string): string {
  const parts: string[] = [];

  // TypeScript strictness
  const tsconfig = readFileSafe(join(projectPath, 'tsconfig.json'));
  if (tsconfig) {
    const ts = parseJsonSafe(tsconfig);
    const opts = (ts?.['compilerOptions'] as Record<string, unknown>) ?? {};
    if (opts['strict'] === true) parts.push('TypeScript strict mode');
    if (opts['noUncheckedIndexedAccess'] === true) parts.push('noUncheckedIndexedAccess');
    if (opts['exactOptionalPropertyTypes'] === true) parts.push('exactOptionalPropertyTypes');
  }

  // ESLint
  const eslintFiles = ['.eslintrc', '.eslintrc.js', '.eslintrc.ts', '.eslintrc.json', '.eslintrc.cjs', 'eslint.config.js', 'eslint.config.ts', 'eslint.config.mjs'];
  if (eslintFiles.some(f => existsSync(join(projectPath, f)))) {
    parts.push('ESLint');
  }

  // Prettier
  const prettierFiles = ['.prettierrc', '.prettierrc.json', '.prettierrc.js', 'prettier.config.js', 'prettier.config.ts'];
  if (prettierFiles.some(f => existsSync(join(projectPath, f)))) {
    parts.push('Prettier');
  }

  // Biome
  if (existsSync(join(projectPath, 'biome.json')) || existsSync(join(projectPath, 'biome.jsonc'))) {
    parts.push('Biome');
  }

  // EditorConfig
  if (existsSync(join(projectPath, '.editorconfig'))) {
    parts.push('EditorConfig');
  }

  // Module type from package.json
  const pkgJson = readFileSafe(join(projectPath, 'package.json'));
  if (pkgJson) {
    const pkg = parseJsonSafe(pkgJson);
    if (pkg?.['type'] === 'module') parts.push('ESM modules');
  }

  // Test framework
  if (existsSync(join(projectPath, 'vitest.config.ts')) || existsSync(join(projectPath, 'vitest.config.js'))) {
    parts.push('Vitest for testing');
  } else if (existsSync(join(projectPath, 'jest.config.js')) || existsSync(join(projectPath, 'jest.config.ts'))) {
    parts.push('Jest for testing');
  }

  // Git hooks
  if (existsSync(join(projectPath, '.husky'))) parts.push('Husky git hooks');
  if (existsSync(join(projectPath, '.lefthook.yml')) || existsSync(join(projectPath, 'lefthook.yml'))) {
    parts.push('Lefthook git hooks');
  }

  return parts.join(', ');
}

// ─── Git helpers ──────────────────────────────────────────────────────────────

/**
 * Resolves the main branch (main or master) SHA.
 * Returns empty SHA and 'main' branch_basis if neither branch exists.
 */
/**
 * Stable project identity: the repo's ROOT (first) commit SHA. Unlike HEAD
 * it never changes as work lands, so the card's project_key stays fixed and
 * refreshes update one row instead of accumulating new ones.
 */
export function getRootCommitSha(projectPath: string): string {
  return tryGit(projectPath, ['rev-list', '--max-parents=0', 'HEAD'])
    .split('\n')[0]!
    .trim();
}

export function getMainBranchSha(projectPath: string): { sha: string; branch: string } {
  for (const branch of ['main', 'master']) {
    const sha = tryGit(projectPath, ['rev-parse', branch]);
    if (sha.length === 40) return { sha, branch };
  }
  // Fallback: try HEAD
  const sha = tryGit(projectPath, ['rev-parse', 'HEAD']);
  if (sha.length === 40) return { sha, branch: 'HEAD' };
  return { sha: '', branch: 'main' };
}

/**
 * Returns how many commits the current HEAD is ahead of baseSha.
 * 0 when HEAD === baseSha or git is unavailable.
 */
export function getCommitsBehind(projectPath: string, baseSha: string): number {
  if (!baseSha) return 0;
  const result = tryGit(projectPath, ['rev-list', '--count', `${baseSha}..HEAD`]);
  const n = parseInt(result, 10);
  return isNaN(n) ? 0 : n;
}

/**
 * Builds a recent-change digest from `git log` on the project.
 * Reports commit messages and changed file paths — no code content.
 */
export function getRecentChangeDigest(projectPath: string, branchBasis: string): string {
  const branch = branchBasis === 'HEAD' ? 'HEAD' : branchBasis;
  // Get last 20 commit messages
  const log = tryGit(projectPath, [
    'log', branch,
    '--oneline',
    '--no-merges',
    '-20',
  ]);
  if (!log) return '';

  // Get changed files from last 10 commits (unique set, no content)
  const files = tryGit(projectPath, [
    'log', branch,
    '--name-only',
    '--format=',
    '--no-merges',
    '-10',
  ]);

  const uniqueFiles = [
    ...new Set(
      files
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0),
    ),
  ].slice(0, 30);

  const parts: string[] = [
    `Recent commits:\n${log}`,
  ];

  if (uniqueFiles.length > 0) {
    parts.push(`Recently changed files: ${uniqueFiles.join(', ')}`);
  }

  return parts.join('\n\n');
}

// ─── Upload ───────────────────────────────────────────────────────────────────

export interface UploadProjectCardOptions {
  /** Server base URL (https://livemerge.dev). Trailing slash stripped. */
  baseUrl: string;
  /** Session token for Authorization Bearer header. */
  sessionToken: string;
  /** Optional fetch override (injected in tests). */
  fetchImpl?: typeof fetch;
}

export interface UploadProjectCardResult {
  ok: boolean;
  status?: number;
  error?: string;
}

/**
 * Serializes and uploads a ProjectCard summary object to the server.
 *
 * Privacy guarantee: only the card's summary fields are transmitted —
 * no raw source code, file contents, or secrets ever leave the machine.
 * The card object itself contains only metadata strings, never code content.
 *
 * Non-blocking contract: accepts both complete (is_incomplete=false) and
 * incomplete (is_incomplete=true) cards. Never throws — network or server
 * errors are captured and returned in the result object.
 */
export async function uploadProjectCard(
  card: ProjectCard,
  opts: UploadProjectCardOptions,
): Promise<UploadProjectCardResult> {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  const url = `${opts.baseUrl.replace(/\/$/, '')}/api/project-card`;

  // Serialize only the typed ProjectCard summary — never raw source files.
  const body = JSON.stringify(card);

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.sessionToken}`,
        'Content-Type': 'application/json',
      },
      body,
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return { ok: false, error };
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Optional collector overrides for dependency injection (primarily used in
 * tests to simulate individual collector failures without mocking ES modules).
 */
export interface ProjectCardCollectors {
  detectStack?: (path: string) => string;
  buildModuleMap?: (path: string) => Record<string, string>;
  detectConventions?: (path: string) => string;
  getMainBranchSha?: (path: string) => { sha: string; branch: string };
  getRecentChangeDigest?: (path: string, branch: string) => string;
  getCommitsBehind?: (path: string, sha: string) => number;
  getRootCommitSha?: (path: string) => string;
}

/**
 * Collects the 5 required fields from the local filesystem and git.
 * Any field that cannot be derived (including when a collector throws) is set
 * to `null` and the card's `status` becomes 'incomplete'; when all 5 derive,
 * status is 'complete'.
 *
 * Each collector is wrapped in a try-catch so that an individual failure
 * stamps the card incomplete rather than propagating an error to the caller.
 * Collectors can be overridden via the optional second argument (for testing).
 *
 * Privacy guarantee: only summary metadata (filenames, commit messages,
 * config keys) is collected. No source code content is read or included.
 */
export function buildProjectCard(
  projectPath: string,
  collectors?: ProjectCardCollectors,
): ProjectCard {
  const _detectStack = collectors?.detectStack ?? detectStack;
  const _buildModuleMap = collectors?.buildModuleMap ?? buildModuleMap;
  const _detectConventions = collectors?.detectConventions ?? detectConventions;
  const _getMainBranchSha = collectors?.getMainBranchSha ?? getMainBranchSha;
  const _getRecentChangeDigest = collectors?.getRecentChangeDigest ?? getRecentChangeDigest;
  const _getCommitsBehind = collectors?.getCommitsBehind ?? getCommitsBehind;

  let stackRaw = '';
  try { stackRaw = _detectStack(projectPath); } catch { /* field → null */ }

  let moduleMapRaw: Record<string, string> = {};
  try { moduleMapRaw = _buildModuleMap(projectPath); } catch { /* field → null */ }

  let conventionsRaw = '';
  try { conventionsRaw = _detectConventions(projectPath); } catch { /* field → null */ }

  let sha = '';
  let branch_basis = 'main';
  try {
    const result = _getMainBranchSha(projectPath);
    sha = result.sha;
    branch_basis = result.branch;
  } catch { /* field → null */ }

  let digestRaw = '';
  try { digestRaw = _getRecentChangeDigest(projectPath, branch_basis); } catch { /* field → null */ }

  let commits_behind = 0;
  try { commits_behind = _getCommitsBehind(projectPath, sha); } catch { /* field → 0 */ }

  const stack = stackRaw || null;
  const module_map = Object.keys(moduleMapRaw).length > 0 ? moduleMapRaw : null;
  const conventions = conventionsRaw || null;
  const recent_change_digest = digestRaw || null;
  const base_commit_sha = sha || null;

  const is_incomplete =
    stack === null ||
    module_map === null ||
    conventions === null ||
    recent_change_digest === null ||
    base_commit_sha === null;
  const status: ProjectCardStatus = is_incomplete ? 'incomplete' : 'complete';

  // Identity comes from the ROOT commit (never moves), NOT from HEAD —
  // a HEAD-based key would change on every commit and each refresh would
  // insert a new card row instead of updating the project's single card.
  const _getRootCommitSha = collectors?.getRootCommitSha ?? getRootCommitSha;
  let rootSha = '';
  try { rootSha = _getRootCommitSha(projectPath); } catch { /* → name only */ }

  const repoName = basename(projectPath);
  const project_id = rootSha
    ? `${repoName}-${rootSha.slice(0, 8)}`
    : repoName;

  return {
    project_id,
    branch_basis,
    stack,
    module_map,
    conventions,
    recent_change_digest,
    base_commit_sha,
    commits_behind,
    status,
    is_incomplete,
    approved: false,
  };
}
