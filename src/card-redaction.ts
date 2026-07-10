/**
 * Fixed redaction policy for project cards (privacy boundary enforcement).
 *
 * The first card upload is member-approved interactively; every subsequent
 * refresh auto-applies THIS policy. It is deliberately conservative:
 *  - code snippets (fenced blocks, long indented runs) are stripped,
 *  - anything that pattern-matches a secret is replaced with [redacted],
 *  - free-text fields are hard-capped so a runaway collector can never
 *    exfiltrate bulk content.
 *
 * The card never contains raw file contents by construction (collectors only
 * read manifests/git metadata) — this policy is the defense-in-depth layer
 * on top of that construction guarantee.
 */

import type { ProjectCard } from './project-card.js';

/** Max characters for any free-text card field after redaction. */
export const FIELD_MAX_CHARS = 4_000;

// Common credential shapes. Order matters: PEM blocks first (multiline).
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI/Anthropic-style API keys
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWTs
  /\bpostgres(?:ql)?:\/\/[^\s'"]+/g, // DB connection strings
  /\b(?:api[_-]?key|secret|token|password)\s*[=:]\s*['"][^'"]{8,}['"]/gi,
];

// Fenced code blocks and 4+ consecutive indented lines read as "code".
const CODE_FENCE = /```[\s\S]*?```/g;
const INDENTED_RUN = /(?:^(?: {4}|\t).*\n?){4,}/gm;

/** Applies the fixed redaction policy to a free-text value. */
export function redactText(value: string): string {
  let out = value.replace(CODE_FENCE, '[code omitted]');
  out = out.replace(INDENTED_RUN, '[code omitted]\n');
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, '[redacted]');
  }
  if (out.length > FIELD_MAX_CHARS) {
    out = `${out.slice(0, FIELD_MAX_CHARS)}… [truncated]`;
  }
  return out;
}

/**
 * Applies the fixed redaction policy to every free-text field of a card.
 * Structural fields (SHAs, counts, flags) pass through untouched.
 */
export function redactCard(card: ProjectCard): ProjectCard {
  const moduleMap = card.module_map
    ? Object.fromEntries(
        Object.entries(card.module_map).map(([dir, desc]) => [
          dir,
          redactText(desc),
        ]),
      )
    : card.module_map;

  return {
    ...card,
    stack: card.stack === null ? null : redactText(card.stack),
    module_map: moduleMap,
    conventions:
      card.conventions === null ? null : redactText(card.conventions),
    recent_change_digest:
      card.recent_change_digest === null
        ? null
        : redactText(card.recent_change_digest),
  };
}
