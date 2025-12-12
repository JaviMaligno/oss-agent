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

Provider selection: Set `ai.executionMode: "cli"` or `"sdk"` in config. SDK mode requires `ANTHROPIC_API_KEY`.

### Configuration

Configuration defined with Zod schemas in `src/types/config.ts`. Loaded from:
1. `~/.oss-agent/config.json`
2. Environment variables (`ANTHROPIC_API_KEY`, `OSS_AGENT_*`)
3. CLI flags

### Current CLI Commands

**Core Workflow:**
- `work <issue-url>` - Work on a GitHub issue
- `iterate` - Address PR feedback
- `watch` - Monitor PRs for feedback
- `resume <session-id>` - Resume a previous session

**Discovery & Selection:**
- `discover` - Find OSS projects matching criteria
- `suggest` - Suggest issues to work on
- `queue` - Manage issue queue (list, add, skip, prioritize, clear)

**Autonomous Mode:**
- `run` - Autonomous mode (work through queue with rate limiting, conflict detection)
- `work-parallel --count N` - Work on N issues in parallel
- `parallel-status` - Show parallel work status

**Monitoring:**
- `prs` - List monitored PRs with feedback status
- `history` - View session history
- `status` - Show current state

**Management:**
- `config` - Manage configuration
- `cleanup` - Clean up worktrees and old data
- `cancel <issue>` - Cancel specific parallel work
- `internal` - Hidden commands for hooks integration

## TypeScript Conventions

- Strict mode enabled with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
- Use `.js` extensions in imports (ESM)
- Prefix unused parameters with `_`
- Explicit return types required on functions (ESLint warning)
- No `any` types allowed (except in tests)
