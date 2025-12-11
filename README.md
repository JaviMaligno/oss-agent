# OSS Contribution Agent

An AI-powered CLI tool for automated open source contributions. Given a GitHub issue URL, the agent analyzes the issue, implements a fix using Claude, and creates a pull request.

## Features

- **Single Issue Workflow**: Provide an issue URL and the agent handles everything from cloning to PR creation
- **Fork-Based Contributions**: Automatically forks repositories when you don't have push access
- **Git Worktrees**: Isolated workspaces for parallel issue work
- **State Persistence**: SQLite-based tracking of issues, sessions, and work records
- **PR Feedback Iteration**: Parse and respond to PR review comments
- **Quality Gates**: Configurable limits on files and lines changed

## Installation

```bash
# Clone the repository
git clone <repo-url>
cd oss-agent

# Install dependencies
pnpm install

# Build
pnpm run build
```

## Prerequisites

- **Node.js** 18+
- **pnpm** package manager
- **Claude CLI** (`claude`) installed and authenticated
- **GitHub CLI** (`gh`) installed and authenticated

## Usage

### Work on an Issue

```bash
# Process a GitHub issue and create a PR
oss-agent work https://github.com/owner/repo/issues/123

# Dry run (analyze without making changes)
oss-agent work https://github.com/owner/repo/issues/123 --dry-run

# Skip PR creation (useful for testing)
oss-agent work https://github.com/owner/repo/issues/123 --skip-pr

# Set a budget limit
oss-agent work https://github.com/owner/repo/issues/123 --max-budget 5.00
```

### View Status

```bash
# Show active sessions and recent issues
oss-agent status

# View operation history
oss-agent history

# View/edit configuration
oss-agent config
```

### Iterate on PR Feedback

```bash
# Process PR feedback and apply fixes
oss-agent iterate https://github.com/owner/repo/pull/456
```

### Cleanup

```bash
# Clean up completed work
oss-agent cleanup --completed

# Clean up specific issue
oss-agent cleanup --issue owner/repo#123
```

## How It Works

1. **Parse Issue**: Extracts issue details (title, body, labels) via `gh` CLI
2. **Setup Repository**:
   - Checks if you have push access
   - Forks the repository if needed
   - Clones and creates a worktree
3. **Create Branch**: Names branch as `oss-agent/issue-{number}-{title-slug}`
4. **AI Implementation**: Invokes Claude CLI to analyze and implement a fix
5. **Quality Check**: Validates changes against configured limits
6. **Commit & Push**: Commits changes and pushes to origin (or fork)
7. **Create PR**: Opens a pull request via `gh pr create`

## Configuration

Configuration is stored in `~/.oss-agent/config.json`:

```json
{
  "ai": {
    "mode": "cli",
    "model": "claude-sonnet-4-20250514",
    "cli": {
      "path": "claude",
      "autoApprove": true,
      "maxTurns": 50
    }
  },
  "budget": {
    "dailyLimitUsd": 50,
    "monthlyLimitUsd": 500,
    "perIssueLimitUsd": 10
  },
  "git": {
    "defaultBranch": "main",
    "branchPrefix": "oss-agent",
    "commitSignoff": false
  },
  "oss": {
    "maxIterations": 3,
    "qualityGates": {
      "maxFilesChanged": 20,
      "maxLinesChanged": 500
    }
  }
}
```

## Project Structure

```
src/
├── cli/                    # CLI commands
│   ├── commands/           # Individual command implementations
│   └── index.ts            # CLI entry point
├── core/                   # Core modules
│   ├── ai/                 # AI provider (Claude CLI)
│   ├── engine/             # Issue processing engine
│   ├── feedback/           # PR feedback parsing
│   ├── git/                # Git operations
│   ├── github/             # GitHub API (fork management)
│   └── state/              # SQLite state manager
├── infra/                  # Infrastructure utilities
│   ├── logger.ts           # Structured logging
│   └── errors.ts           # Error types
└── types/                  # TypeScript type definitions
```

## Development

```bash
# Run in development mode
pnpm run dev

# Run tests
pnpm test

# Run tests once
pnpm test:run

# Type check
pnpm run typecheck

# Lint
pnpm run lint
```

## Current Status

**Implemented:**
- Phase 0: Project setup
- Phase 1: Core engine (single issue flow)
- Phase 2: State management
- Phase 3: Feedback parsing (partial)
- Phase 4: Fork management

**In Progress:**
- Phase 4: Issue discovery & selection commands

See [docs/implementation-plan.md](docs/implementation-plan.md) for full roadmap.

## Architecture

See [docs/module-structure.md](docs/module-structure.md) for detailed architecture.

## License

MIT
