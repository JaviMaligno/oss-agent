# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

oss-agent is an AI-powered CLI tool for automating open source contributions and internal maintenance tasks. It uses the Claude Agent SDK (or CLI) to analyze GitHub issues, implement solutions, and create pull requests with an automated feedback loop.

## Common Commands

```bash
# Development
pnpm install           # Install dependencies
pnpm run dev           # Run CLI in development mode (tsx)
pnpm run build         # Compile TypeScript to dist/
pnpm run typecheck     # Type check without emitting

# Testing
pnpm test              # Run tests in watch mode
pnpm test:run          # Run tests once

# Linting & Formatting
pnpm run lint          # Run ESLint
pnpm run lint:fix      # Fix ESLint issues
pnpm run format        # Format with Prettier
pnpm run format:check  # Check formatting

# Running the built CLI
node dist/cli/index.js <command>
```

## Architecture

### Layer Structure

The codebase follows a layered architecture:

1. **CLI Layer** (`src/cli/`) - Command definitions using Commander.js
2. **Core Modules** (`src/core/`) - Shared functionality: AI provider, state, git, engine
3. **Mode-Specific** (`src/oss/`, `src/b2b/`) - OSS and B2B specific features (planned)
4. **Infrastructure** (`src/infra/`) - Logging, errors, utilities
5. **Types** (`src/types/`) - Shared TypeScript types with Zod schemas

### Key Design Decisions

- **Dual AI execution modes**: CLI mode (spawns `claude` process) vs SDK mode (direct API). CLI is default for local development using existing Claude Code auth.
- **SQLite for state** (`better-sqlite3`): Stores sessions, issues, audit logs in `~/.oss-agent/state.db`
- **Git worktrees**: Enables parallel work on multiple issues from the same repo
- **GitHub CLI (`gh`)**: Primary interface for GitHub operations (already authenticated)

### AI Provider Abstraction

Both providers implement `AIProvider` interface (`src/core/ai/types.ts`):
- `ClaudeCLIProvider`: Spawns claude CLI with `--print --dangerously-skip-permissions`
- `ClaudeSDKProvider`: Uses `@anthropic-ai/claude-code` SDK directly (requires API key)
  - Includes session caching with TTL (30 min default) for faster follow-up queries
  - Supports session resume to avoid re-indexing repositories

Provider selection: Set `ai.executionMode: "cli"` or `"sdk"` in config. SDK mode requires `ANTHROPIC_API_KEY`.

Model selection: By default, no model is specified and Claude uses the best available (currently Opus 4.5). Override with `ai.model` in config.

### Configuration

Configuration defined with Zod schemas in `src/types/config.ts`. Loaded from:
1. `~/.oss-agent/config.json`
2. Environment variables (`ANTHROPIC_API_KEY`, `OSS_AGENT_*`)
3. CLI flags

### Skills System

oss-agent includes built-in skills that provide specialized guidance for common tasks:

**Available Skills** (in `.claude/skills/`):
- `feature-dev` - Guides feature development with project-specific patterns
- `code-review` - PR review with security checklist and severity levels
- `commit-pr` - Git commit conventions and PR templates

**How Skills Work:**
- Skills are markdown files with YAML frontmatter
- Claude automatically loads skills from `.claude/skills/` when matching tasks
- In SDK mode, skills are enabled via `settingSources: ["user", "project"]`

**Skill Module** (`src/core/skills/`):
- `types.ts` - Universal skill interface supporting multiple providers
- `loader.ts` - Loads skills from filesystem
- `adapters/` - Provider-specific adapters (Claude, Gemini, OpenAI stubs)

**Configuration** (`skills` in config):
```json
{
  "skills": {
    "enabled": true,
    "directory": ".claude/skills",
    "builtin": {
      "featureDev": true,
      "codeReview": true,
      "commitPr": true
    }
  }
}
```

### Current CLI Commands

**Core Workflow:**
- `work <issue-url>` - Work on a GitHub issue
  - `--dry-run` - Analyze without changes
  - `--skip-pr` - Skip PR creation
  - `--max-budget <usd>` - Per-issue budget limit
  - `--resume` - Resume previous session
  - `--review` - Auto-review PR after creation
  - `--wait-for-ci / --no-wait-for-ci` - Control CI waiting (default: wait)
  - `--auto-fix-ci / --no-auto-fix-ci` - Auto-fix CI failures (default: fix)
  - `--max-fix-iterations <n>` - Max test fix attempts (default: 10)
  - `--single-session` - Combine impl + tests in one AI session (experimental)
- `iterate <pr-url>` - Address PR feedback
- `review <pr-url>` - Review a PR with AI second-opinion
  - `--auto-fix / --no-auto-fix` - Auto-fix found issues (default: fix)
  - `--post-comment / --no-post-comment` - Post as PR comment (default: post)
- `watch` - Monitor PRs for feedback
- `resume <session-id>` - Resume a previous session

**Discovery & Selection:**
- `discover` - Find OSS projects matching criteria
- `suggest <owner/repo>` - Suggest issues to work on
- `queue` - Manage issue queue (list, add, skip, prioritize, clear)

**Autonomous Mode:**
- `run` - Autonomous mode (work through queue with rate limiting, conflict detection)
- `work-parallel <urls...>` - Work on multiple issues in parallel
  - `--count N` - Max concurrent agents
  - `--max-budget <usd>` - Total budget for all issues
  - `--skip-pr` - Skip PR creation
- `parallel-status` - Show parallel work status
  - `--all` - Include completed sessions
  - `--session <id>` - Show specific session details

**Monitoring:**
- `prs` - List monitored PRs with feedback status
- `history` - View session history
- `status` - Show current state

**Management:**
- `config` - Manage configuration
- `cleanup` - Clean up worktrees and old data
- `cancel <issue>` - Cancel specific parallel work
  - `--all` - Cancel all parallel work
- `audit [repo-url]` - Audit a repository for issues
  - `--categories <list>` - Categories to audit (security, documentation, code-quality)
  - `--discover` - Discover and audit multiple repos
  - `--skip-issues` - Don't create GitHub issues
  - `--min-severity <level>` - Filter by severity
- `internal` - Hidden commands for hooks integration

**B2B/Enterprise (Campaign Mode):**
- `campaign list` - List campaigns
- `campaign create <name>` - Create a campaign
- `campaign run <id>` - Process issues in a campaign
- `campaign issues <id>` - View campaign issues

**Server Mode:**
- `serve` - Start MCP server for tool integration
  - `--stdio` - Use stdio transport (default, for Claude Desktop/Code)
  - `--http` - Use HTTP/SSE transport
  - `--port <port>` - HTTP server port
- `webhook` - Start GitHub webhook server
  - `--port <port>` - Port to listen on
  - `--secret <secret>` - GitHub webhook secret
  - `--delete-branch-on-merge` - Delete source branch when PR is merged
  - `--no-auto-iterate` - Don't auto-trigger iterate on PR feedback

## TypeScript Conventions

- Strict mode enabled with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
- Use `.js` extensions in imports (ESM)
- Prefix unused parameters with `_`
- Explicit return types required on functions (ESLint warning)
- No `any` types allowed (except in tests)
