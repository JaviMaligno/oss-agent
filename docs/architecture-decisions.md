# Architecture Decision Records (ADR)

This document tracks significant architectural decisions made during the development of the OSS Contribution Agent. Each decision is recorded with context, options considered, and rationale.

---

## ADR-001: TypeScript as Primary Language

**Date**: 2024-12-10

**Status**: Accepted

### Context

Need to choose a primary language for implementing the agent. Key considerations:
- Integration with Claude Agent SDK (TypeScript/JavaScript native)
- MCP server ecosystem (primarily TypeScript)
- Developer productivity
- Type safety for complex state management

### Options Considered

1. **TypeScript** - Native SDK support, strong typing, good async handling
2. **Python** - More familiar in ML/AI space, good CLI tooling
3. **Rust** - Performance, but slower development, SDK not native

### Decision

**TypeScript** with strict mode enabled.

### Rationale

- Claude Agent SDK is TypeScript-first with best documentation and examples
- MCP servers are predominantly TypeScript
- Strong typing helps manage complex state (issues, sessions, campaigns)
- Excellent async/await support for concurrent operations
- Good CLI frameworks available (Commander.js, oclif)

### Consequences

- Need to handle some Python-based tools via subprocess (e.g., linters)
- Team needs TypeScript proficiency
- Can leverage existing Node.js ecosystem

---

## ADR-002: Claude Agent SDK vs Direct API Calls

**Date**: 2024-12-10

**Status**: Accepted

### Context

Need to decide how to integrate with Claude for AI operations:
- Direct Anthropic API calls (more control)
- Claude Agent SDK (higher-level abstraction)

### Options Considered

1. **Claude Agent SDK**
   - Pros: Built-in tool handling, session management, cost tracking
   - Cons: Less control, SDK updates may break things

2. **Direct API**
   - Pros: Full control, no SDK dependency
   - Cons: Must implement tool execution, message handling, etc.

3. **Hybrid**
   - Use SDK for main flows, direct API for specific needs

### Decision

**Claude Agent SDK** as primary, with abstraction layer allowing fallback.

### Rationale

- SDK provides exactly what we need: tool execution, session management, budget control
- `query()` function maps directly to our "work on issue" flow
- Built-in cost tracking via `maxBudgetUsd`
- Session persistence for feedback loop (`--resume`)
- Reduces implementation time significantly

### Consequences

- Must keep SDK updated
- AIProvider abstraction layer allows switching if needed
- Some advanced scenarios may need SDK source diving

---

## ADR-003: SQLite for State Persistence

**Date**: 2024-12-10

**Status**: Accepted

### Context

Need persistent storage for:
- Issue states and history
- Session data for resume
- Budget tracking
- Audit logs

Requirements:
- Must work locally (CLI tool)
- No external database dependencies
- Simple backup/restore
- Queryable for reporting

### Options Considered

1. **SQLite** (via better-sqlite3)
   - Pros: Zero config, single file, SQL queries, excellent performance
   - Cons: Not distributed (fine for our use case)

2. **JSON files**
   - Pros: Human readable, simple
   - Cons: No queries, corruption risk, doesn't scale

3. **LevelDB/RocksDB**
   - Pros: Fast key-value
   - Cons: No SQL, harder to query

4. **PostgreSQL/MySQL**
   - Pros: Full SQL, distributed
   - Cons: External dependency, overkill for CLI

### Decision

**SQLite** via `better-sqlite3` (synchronous API).

### Rationale

- Perfect for single-user CLI tool
- SQL makes complex queries easy (e.g., "issues by state per project")
- Single file = easy backup, move between machines
- `better-sqlite3` is synchronous which simplifies code
- Can migrate to PostgreSQL later if B2B needs it (SQL is portable)

### Consequences

- Database file in `~/.oss-agent/state.db`
- Need migration strategy for schema changes
- Must handle concurrent access carefully (worktree parallel work)

---

## ADR-004: Git Worktrees for Parallel Work

**Date**: 2024-12-10

**Status**: Accepted

### Context

Need to work on multiple issues from the same repository simultaneously. Options:
1. Clone repo multiple times
2. Use git worktrees
3. Sequential-only processing

### Decision

**Git worktrees** for parallel work within same repository.

### Rationale

- Worktrees share `.git` objects = much less disk space
- Fast creation (seconds vs minutes for full clone)
- Native git isolation between branches
- Easy cleanup with `git worktree remove`

### Implementation

```
~/.oss-agent/worktrees/
├── poetry-issue-10569/     # Branch: fix/issue-10569
├── poetry-issue-10234/     # Branch: feat/issue-10234
└── poetry-issue-9876/      # Branch: fix/issue-9876
```

### Consequences

- Need WorktreeManager class
- Must detect conflicts between parallel issues
- Cleanup required after completion

---

## ADR-005: Hooks for Feedback Loop (not Polling)

**Date**: 2024-12-10

**Status**: Accepted

### Context

Need to handle PR feedback and iterate. Two main approaches:
1. Continuous polling for PR updates
2. Event-driven via Claude Code hooks + external monitor

### Decision

**Hooks-based architecture** with lightweight polling monitor.

### Rationale

- Hooks capture exact moment PR is created
- Session state preserved at PR creation
- Resume injects feedback directly into context
- More efficient than continuous agent running
- Aligns with Claude Code's native capabilities

### Implementation

```
Hooks Flow:
1. Agent creates PR → Stop hook saves session + registers PR
2. Monitor polls for feedback (runs separately, low resource)
3. Feedback detected → Update state file
4. Resume triggered → Start hook injects feedback
5. Agent addresses feedback in same context
```

### Consequences

- Need external monitor service (can be simple cron or daemon)
- Hook scripts must be robust
- Session resumption depends on Claude Code's resume capability

---

## ADR-006: GitHub CLI (`gh`) vs GitHub API

**Date**: 2024-12-10

**Status**: Accepted

### Context

Need to interact with GitHub for:
- Reading issues
- Creating PRs
- Monitoring PR comments
- Repository operations

### Options

1. **GitHub CLI (`gh`)**
   - Pros: Already authenticated, handles rate limiting, simple commands
   - Cons: Subprocess overhead, parsing output

2. **GitHub API directly**
   - Pros: Full control, typed responses
   - Cons: Auth handling, rate limit management

3. **Octokit SDK**
   - Pros: Typed, well-maintained
   - Cons: Another dependency, still need auth

### Decision

**GitHub CLI (`gh`)** as primary, with direct API for complex queries.

### Rationale

- `gh` is already installed and authenticated on developer machines
- Handles rate limiting gracefully
- JSON output is easy to parse
- For B2B, will add GitHub Enterprise support later
- MCP GitHub server as future alternative

### Consequences

- `gh` is a runtime dependency
- Need to parse JSON output
- Some operations may need API fallback

---

## ADR-007: Modular Architecture for OSS/B2B Modes

**Date**: 2024-12-10

**Status**: Accepted

### Context

System needs to support two modes:
1. OSS mode: Contribute to public open source projects
2. B2B mode: Internal maintenance, campaigns on private repos

Could build as:
- Two separate products
- One product with feature flags
- Modular system with shared core

### Decision

**Modular architecture** with shared core and mode-specific modules.

### Rationale

- ~80% of code is shared (git, AI, state, feedback loop)
- OSS-specific: project discovery, "good first issue" logic
- B2B-specific: Jira integration, campaign management, reporting
- Single codebase, easier maintenance
- Users can start with OSS and upgrade to B2B

### Structure

```
src/
├── core/           # Shared: engine, git, state, budget, feedback
├── oss/            # OSS: discovery, issue selection, scoring
├── b2b/            # B2B: jira, campaigns, reporting
└── cli/            # CLI commands (may import from oss/ or b2b/)
```

### Consequences

- Clear module boundaries required
- Core must be agnostic to issue source
- Some duplication acceptable to maintain separation

---

## ADR-008: Anti-Spam Safeguards as First-Class Feature

**Date**: 2024-12-10

**Status**: Accepted

### Context

AI-generated PRs have a reputation problem. Maintainers are overwhelmed with low-quality "AI slop". To be successful, this tool must NOT contribute to that problem.

### Decision

**Built-in safeguards are mandatory, not optional**.

### Implementation

1. **Rate limits enforced by default**
   - Max 2 PRs per project per day
   - Max 10 PRs total per day
   - Configurable but with sensible defaults

2. **Quality gates before PR creation**
   - Tests must pass (if test command detected)
   - Linting must pass (if lint command detected)
   - Changes must be within size limits

3. **Transparency**
   - PRs include footer: "Changes prepared with assistance from OSS-Agent"
   - Never hide AI involvement

4. **Conservative by default**
   - Only target issues with "good first issue" or "help wanted" labels initially
   - Prefer repos with automated feedback tools
   - Skip issues with existing PRs or assignees

5. **Escape hatches for power users**
   - Can override for own projects
   - B2B mode has different defaults (it's your own code)

### Consequences

- Slower progress but better reputation
- May need "aggressive mode" toggle for own projects
- Audit log tracks all operations for accountability

---

## ADR-009: Cost Tracking and Budget Control

**Date**: 2024-12-10

**Status**: Accepted

### Context

AI operations cost money. Users need visibility and control to avoid surprises.

### Decision

**Multi-level budget system with hard stops**.

### Implementation

```typescript
interface BudgetConfig {
  global: {
    dailyBudgetUsd: number;      // e.g., 50
    monthlyBudgetUsd: number;    // e.g., 500
  };
  perOperation: {
    perIssue: number;            // e.g., 5
    perFeedbackIteration: number; // e.g., 2
  };
}
```

Behavior:
- Track cost after each AI call
- Warn at 80% of daily/monthly limit
- Hard stop at 100%
- Per-issue cap prevents runaway single issue
- Display cost in all status commands

### Rationale

- Claude Agent SDK provides `maxBudgetUsd` - use it
- Users from viability analysis expect cost control
- Makes ROI calculation possible for B2B

### Consequences

- Must aggregate costs across parallel operations
- Need cost estimation before starting work
- Budget state must be durable (SQLite)

---

## ADR-010: CLI vs SDK Execution Modes

**Date**: 2024-12-10

**Status**: Accepted

### Context

The agent needs to execute AI queries (prompts to Claude) to analyze code and implement changes. There are two ways to do this:

1. **SDK Mode**: Use the Anthropic API directly via `@anthropic-ai/claude-code` SDK
2. **CLI Mode**: Spawn `claude` CLI process as a subprocess

For local development, the developer may not have a separate API key but does have Claude Code CLI installed and authenticated.

### Options Considered

1. **SDK-only**
   - Pros: Programmatic control, cost tracking, session management
   - Cons: Requires ANTHROPIC_API_KEY, additional cost beyond subscription

2. **CLI-only**
   - Pros: Uses existing auth, no API key needed, familiar workflow
   - Cons: Less programmatic control, output parsing needed

3. **Dual-mode (CLI default, SDK optional)**
   - Pros: Flexibility, works without API key, can upgrade to SDK
   - Cons: More code to maintain, two execution paths

### Decision

**Dual-mode architecture** with CLI as default for local development.

```typescript
ai: {
  executionMode: "cli" | "sdk",  // Default: "cli"
  cli: {
    path: "claude",              // Path to CLI binary
    autoApprove: true,           // --dangerously-skip-permissions
    maxTurns: 50,
  }
}
```

### Rationale

1. **No API key barrier for getting started** - Developers can use their existing Claude Code subscription
2. **Full auto-approve by default** - For automated agent work, we want `--dangerously-skip-permissions`
3. **SDK available for production** - When deployed or when cost tracking needed
4. **Same interface** - Both providers implement `AIProvider`, so the rest of the code is agnostic

### CLI Execution Details

```bash
# What we spawn:
claude --print --dangerously-skip-permissions --output-format text --max-turns 50 --model claude-sonnet-4-20250514 --

# Prompt passed via stdin for:
# - Larger prompts
# - Special characters
# - Multi-line content
```

### Logging Strategy

- All CLI output logged to file: `~/.oss-agent/logs/sessions/<operation>-<timestamp>.log`
- Console shows summarized progress (tool calls, major steps)
- Full transcript available in log file for debugging

### Consequences

- CLI mode doesn't report costs (can't track spending automatically)
- Need to handle CLI output parsing (varies by version)
- Session resume uses `claude --resume` flag
- Developer can switch to SDK mode by setting `ANTHROPIC_API_KEY` and `ai.executionMode: "sdk"`

---

## Template for Future ADRs

```markdown
## ADR-XXX: [Title]

**Date**: YYYY-MM-DD

**Status**: Proposed | Accepted | Deprecated | Superseded

### Context

[What is the issue that we're seeing that is motivating this decision?]

### Options Considered

1. **Option A** - Pros/Cons
2. **Option B** - Pros/Cons

### Decision

[What is the decision that was made?]

### Rationale

[Why was this decision made?]

### Consequences

[What are the results of this decision?]
```
