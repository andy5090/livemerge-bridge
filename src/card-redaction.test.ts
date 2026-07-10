import { describe, expect, it } from 'vitest';
import { FIELD_MAX_CHARS, redactCard, redactText } from './card-redaction.js';
import type { ProjectCard } from './project-card.js';

function makeCard(overrides: Partial<ProjectCard> = {}): ProjectCard {
  return {
    project_id: 'my-app-abcd1234',
    branch_basis: 'main',
    stack: 'Node.js, TypeScript, React',
    module_map: { 'app/': 'routes and UI' },
    conventions: 'ESLint + Prettier',
    recent_change_digest: 'feat: added billing',
    base_commit_sha: 'a'.repeat(40),
    commits_behind: 0,
    status: 'complete',
    is_incomplete: false,
    approved: true,
    ...overrides,
  };
}

describe('redactText', () => {
  it('strips fenced code blocks', () => {
    const input = 'Uses hooks.\n```ts\nconst secret = 1;\n```\nDone.';
    const out = redactText(input);
    expect(out).not.toContain('const secret');
    expect(out).toContain('[code omitted]');
  });

  it('strips long indented runs (pasted code)', () => {
    const code = Array.from({ length: 6 }, (_, i) => `    line${i}();`).join('\n');
    const out = redactText(`intro\n${code}\noutro`);
    expect(out).not.toContain('line3();');
    expect(out).toContain('[code omitted]');
  });

  it('redacts AWS keys, GitHub tokens, API keys, JWTs, and DB URLs', () => {
    const samples = [
      'AKIAIOSFODNN7EXAMPLE',
      'ghp_abcdefghijklmnopqrstuvwxyz012345',
      'sk-abcdefghijklmnopqrstuvwx',
      `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(10)}`,
      'postgresql://user:pass@db.example.com:5432/prod',
    ];
    for (const sample of samples) {
      const out = redactText(`value: ${sample} end`);
      expect(out, sample).not.toContain(sample);
      expect(out).toContain('[redacted]');
    }
  });

  it('redacts key=value credential assignments', () => {
    const out = redactText(`api_key = "super-secret-value-123"`);
    expect(out).not.toContain('super-secret-value-123');
  });

  it('strips PEM private key blocks', () => {
    const pem = `-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----`;
    const out = redactText(`before ${pem} after`);
    expect(out).not.toContain('MIIEow');
  });

  it('caps field length', () => {
    const out = redactText('x'.repeat(FIELD_MAX_CHARS + 500));
    expect(out.length).toBeLessThanOrEqual(FIELD_MAX_CHARS + 20);
    expect(out).toContain('[truncated]');
  });

  it('leaves clean prose untouched', () => {
    const input = 'React Router v7 app with Drizzle ORM and tRPC.';
    expect(redactText(input)).toBe(input);
  });
});

describe('redactCard', () => {
  it('redacts every free-text field including module_map values', () => {
    const card = makeCard({
      stack: 'Node sk-abcdefghijklmnopqrstuvwx',
      module_map: { 'src/': 'holds ghp_abcdefghijklmnopqrstuvwxyz012345' },
      conventions: '```js\nlet x;\n```',
      recent_change_digest: 'postgres://u:p@h/db touched',
    });
    const out = redactCard(card);
    expect(out.stack).toContain('[redacted]');
    expect(out.module_map!['src/']).toContain('[redacted]');
    expect(out.conventions).toContain('[code omitted]');
    expect(out.recent_change_digest).toContain('[redacted]');
  });

  it('passes structural fields through untouched and preserves nulls', () => {
    const card = makeCard({
      stack: null,
      module_map: null,
      status: 'incomplete',
      is_incomplete: true,
      commits_behind: 7,
    });
    const out = redactCard(card);
    expect(out.stack).toBeNull();
    expect(out.module_map).toBeNull();
    expect(out.base_commit_sha).toBe(card.base_commit_sha);
    expect(out.commits_behind).toBe(7);
    expect(out.is_incomplete).toBe(true);
  });
});
