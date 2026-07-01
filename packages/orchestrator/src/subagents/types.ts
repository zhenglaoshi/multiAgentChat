/**
 * Claude Code custom subagent definition (backed by a Markdown file with YAML frontmatter).
 *
 * File locations we scan:
 * - `~/.claude/agents/*.md`             — user global
 * - `<projectRoot>/.claude/agents/*.md` — project local (higher priority when both exist)
 */
export interface SubagentDef {
  /** Kebab-case unique name, matches `subagent_type` used by Task tool */
  name: string;
  description?: string;
  /** Tool whitelist (parsed from comma-separated string in frontmatter) */
  tools?: string[];
  model?: string;
  color?: string;
  /** System-prompt body below the frontmatter */
  body: string;
  location: 'user' | 'project';
  /** Absolute file path on disk */
  filePath: string;
}

export interface WriteSubagentInput {
  name: string;
  description?: string;
  tools?: string[];
  model?: string;
  color?: string;
  body: string;
  /** Default 'user' (write to ~/.claude/agents/) */
  location?: 'user' | 'project';
}
