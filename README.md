# OSS Contribution Agent

An AI-powered CLI tool for automated open source contributions. Given a GitHub issue URL, the agent analyzes the issue, implements a fix using Claude, and creates a pull request.

## Features

- **Single Issue Workflow**: Provide an issue URL and the agent handles everything from cloning to PR creation
- **Parallel Work**: Process multiple issues concurrently with configurable limits
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

### Optional (for B2B mode)

- **GitLab CLI** (`glab`) - for GitLab repository support
- **Jira API Token** - for Jira issue source integration
- **Linear API Key** - for Linear issue source integration

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

# Control CI behavior
oss-agent work <url> --wait-for-ci          # Wait for CI checks (default)
oss-agent work <url> --no-wait-for-ci       # Skip CI check waiting
oss-agent work <url> --auto-fix-ci          # Auto-fix failed CI (default)
oss-agent work <url> --no-auto-fix-ci       # Don't auto-fix CI failures
oss-agent work <url> --max-fix-iterations 5 # Limit test fix attempts (default: 10)

# Single-session mode (experimental)
oss-agent work <url> --single-session       # Combine impl + tests in one AI session

# Auto-review the PR after creation
oss-agent work <url> --review
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

### Parallel Work

```bash
# Work on multiple issues in parallel
oss-agent work-parallel https://github.com/owner/repo/issues/1 https://github.com/owner/repo/issues/2 https://github.com/owner/repo/issues/3

# Limit concurrent agents
oss-agent work-parallel --count 2 <urls...>

# Set total budget for all issues
oss-agent work-parallel --max-budget 10.00 <urls...>

# Skip PR creation
oss-agent work-parallel --skip-pr <urls...>

# Check parallel work status
oss-agent parallel-status

# Show all parallel sessions (including completed)
oss-agent parallel-status --all

# Show details for a specific session
oss-agent parallel-status --session <session-id>

# Cancel specific issue or all parallel work
oss-agent cancel <issue-url>
oss-agent cancel --all
```

### Cleanup

```bash
# Clean up completed work
oss-agent cleanup --completed

# Clean up specific issue
oss-agent cleanup --issue owner/repo#123
```

## Recommendations & Considerations

### Cost Awareness

⚠️ **AI usage can be expensive.** Each issue typically costs $0.50-$5.00 depending on complexity and model used.

- **Budget limits are essential**: Configure `budget.perIssueLimitUsd` to prevent runaway costs
- **Daily/monthly caps**: Set `budget.dailyLimitUsd` and `budget.monthlyLimitUsd` as safety nets
- **Model choice matters**: Opus 4.5 (default) is more capable but costs ~10x more than Sonnet
- **Large repositories**: Indexing time adds to cost. The first run on a repo is slower

```bash
# Check your current costs
oss-agent status

# Set conservative limits
oss-agent config set budget.perIssueLimitUsd 2
oss-agent config set budget.dailyLimitUsd 20
```

### Time Expectations

Processing an issue typically takes **5-20 minutes** depending on:

| Factor | Impact |
|--------|--------|
| Repository size | Large repos need more indexing time (first run: 5-10 min) |
| Issue complexity | Simple fixes: 5 min, complex features: 15-20 min |
| Test suite | Running tests adds time per iteration |
| CI checks | Waiting for CI can add 5-15 min |

**Tips for faster iteration:**
- Use `--no-wait-for-ci` during development/testing
- Use `--max-fix-iterations 3` to limit fix attempts
- Consider `--single-session` for simpler issues (experimental)

### Quality Trade-offs

| Option | Quality | Speed | Cost |
|--------|---------|-------|------|
| Default settings | ✅ Best | Slower | Higher |
| `--single-session` | ⚠️ May miss issues | Fast | Lower |
| `--no-auto-fix-ci` | ⚠️ Manual fixes needed | Fast | Lower |
| `--max-fix-iterations 3` | ⚠️ May leave failing tests | Moderate | Moderate |
| Sonnet model | ⚠️ Less capable | Same | Much lower |

### Best Practices

1. **Start with dry-run**: Use `--dry-run` to preview what the agent would do
2. **Monitor first few PRs**: Review the agent's work before trusting it fully
3. **Set budget limits first**: Always configure budget before extensive use
4. **Use review mode**: `--review` provides automated second-opinion on PRs
5. **Fork-based workflow**: The agent auto-forks when you lack push access - this is the safest approach for OSS

### When to Use Single-Session Mode

`--single-session` combines implementation and test fixing in one AI session, reducing re-indexing time. Use it when:

- ✅ Working on simple, well-defined issues
- ✅ The test suite is fast
- ✅ You're iterating quickly and will review manually

**Avoid** single-session mode for:
- ❌ Complex multi-file changes
- ❌ Issues requiring multiple rounds of test fixes
- ❌ When you need maximum reliability

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

### Campaign Management (B2B Mode)

For batch processing of issues from external sources (Jira, Linear, GitHub search):

```bash
# List campaigns
oss-agent campaign list
oss-agent campaign list --status active

# Create a campaign
oss-agent campaign create "Sprint 42 Bug Fixes" --description "Fix all P1 bugs"
oss-agent campaign create "Jira Issues" --source jira_jql --budget 100

# Add issues to a campaign
oss-agent campaign add-issues <campaign-id> https://github.com/org/repo/issues/1 https://github.com/org/repo/issues/2

# Show campaign details
oss-agent campaign show <campaign-id>

# Start/pause/resume a campaign
oss-agent campaign start <campaign-id>
oss-agent campaign pause <campaign-id>
oss-agent campaign resume <campaign-id>

# Run campaign (process issues)
oss-agent campaign run <campaign-id>
oss-agent campaign run <campaign-id> --max-issues 5 --dry-run

# View campaign issues
oss-agent campaign issues <campaign-id>
oss-agent campaign issues <campaign-id> --failed

# Cancel or delete
oss-agent campaign cancel <campaign-id>
oss-agent campaign delete <campaign-id>
```

## Configuration

Configuration is stored in `~/.oss-agent/config.json`:

```json
{
  "ai": {
    "executionMode": "cli",
    "cli": {
      "maxTurns": 50
    }
  },
  "git": {
    "branchPrefix": "oss-agent",
    "defaultBranch": "main",
    "existingBranchStrategy": "auto-clean"
  },
  "budget": {
    "dailyLimitUsd": 50,
    "monthlyLimitUsd": 500,
    "perIssueLimitUsd": 5
  },
  "parallel": {
    "maxConcurrentAgents": 3,
    "maxConcurrentPerProject": 2,
    "maxWorktrees": 10,
    "enableConflictDetection": true
  }
}
```

### AI Model Selection

By default, no model is specified and Claude CLI uses the best available model (currently Opus 4.5). You can override this:

```bash
# Set a specific model
oss-agent config set ai.model claude-sonnet-4-20250514

# Remove model override (use best available)
oss-agent config set ai.model ""
```

### Branch Handling Strategies

The `git.existingBranchStrategy` setting controls how the agent handles existing branches when starting work on an issue:

- **`auto-clean`** (default): Automatically delete existing branches (local and remote fork) and start fresh
- **`reuse`**: Reuse the existing branch if found
- **`suffix`**: Create a new branch with a numeric suffix (e.g., `branch-2`, `branch-3`)
- **`fail`**: Fail if the branch already exists

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
│   ├── providers/          # Provider abstraction layer
│   │   ├── repository/     # GitHub, GitLab, Bitbucket providers
│   │   └── issue-source/   # Jira, Linear providers
│   └── state/              # SQLite state manager
├── b2b/                    # B2B/Enterprise features
│   └── campaigns/          # Campaign management
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
- Phase 3: Feedback parsing (partial) + Budget enforcement
- Phase 4: Fork management, issue discovery & selection
- Phase 5: Parallel work with worktrees
- Phase 6: B2B mode with provider abstraction
  - Repository providers: GitHub, GitHub Enterprise, GitLab
  - Issue source providers: Jira, Linear
  - Campaign management system

**Upcoming:**
- Phase 7: Advanced features & polish

See [docs/implementation-plan.md](docs/implementation-plan.md) for full roadmap.

## Architecture

See [docs/module-structure.md](docs/module-structure.md) for detailed architecture.

## License

MIT
