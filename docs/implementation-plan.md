# Implementation Plan - OSS Contribution Agent

## Overview

This document outlines the phased implementation approach for building the OSS Contribution Agent. The system is designed with a modular architecture that supports two deployment modes:

1. **Personal/OSS Mode**: Automated contributions to open source projects
2. **B2B Mode**: Internal maintenance, bug campaigns, and migrations for private repositories

The core engine is shared between both modes, with specialized modules for each use case.

---

## Guiding Principles

1. **Core first, specializations later** - Build the shared infrastructure before mode-specific features
2. **Vertical slices** - Each phase delivers a working, usable increment
3. **Dogfooding** - Use the tool on real OSS projects as we build it
4. **Minimal viable each step** - Resist the urge to over-engineer early

---

## Phase 0: Project Setup & Foundation

**Goal**: Establish project structure, tooling, and basic infrastructure.

**Duration estimate**: ~2-3 days

### Tasks

- [X] Initialize TypeScript project with strict configuration
- [X] Set up ESLint, Prettier, and pre-commit hooks
- [X] Configure testing framework (Vitest)
- [X] Set up project structure following module-structure.md
- [X] Create basic CLI skeleton with Commander.js
- [X] Set up environment variable handling (dotenv + zod validation)
- [X] Initialize git repository with conventional commits

### Deliverables

```
oss-agent/
├── src/
│   ├── cli/           # CLI entry points
│   ├── core/          # Shared core modules
│   ├── oss/           # OSS-specific modules
│   ├── b2b/           # B2B-specific modules (later)
│   └── index.ts
├── tests/
├── docs/
├── package.json
├── tsconfig.json
└── ...
```

### Exit Criteria

- `pnpm dev` runs without errors
- `pnpm test` runs (even if no tests yet)
- `pnpm lint` passes
- Basic `oss-agent --help` works

---

## Phase 1: Core Engine - Single Issue Flow

**Goal**: Implement the minimal path from "given an issue URL" to "PR created".

**Duration estimate**: ~1-2 weeks

### Dependencies

- Phase 0 complete

### Tasks

#### 1.1 AI Provider Abstraction

- [X] Define `AIProvider` interface
- [X] Implement `ClaudeCLIProvider` using Claude CLI (`--print` mode)
- [X] Basic prompt construction for code tasks
- [X] Cost tracking per query (partial - turns tracked, cost not reported by CLI)

#### 1.2 Git Operations Manager

- [X] Clone/fetch repository
- [X] Branch creation with naming conventions
- [X] Commit with conventional commit format
- [X] Git worktree support for isolated work
- [X] Fork detection and auto-forking for upstream repos

#### 1.3 Contribution Engine (MVP)

- [X] Issue parsing (extract title, body, labels from URL)
- [X] Implementation prompt generation
- [X] Code modification execution via Claude CLI
- [X] Quality gates (max files, max lines changed)

#### 1.4 PR Creation

- [X] Generate PR title and description from issue
- [X] Create PR via GitHub CLI (`gh`)
- [X] Link PR to issue
- [X] Fork-based PR creation (user:branch format)

#### 1.5 CLI Commands (Phase 1)

- [X] `oss-agent work <issue-url>` - Full flow for single issue
- [X] `oss-agent config` - View/edit configuration
- [X] Basic progress output during execution (step indicators)

### Deliverables

Working command:

```bash
oss-agent work https://github.com/owner/repo/issues/123
```

That:

1. Clones/fetches the repo
2. Reads the issue
3. Uses Claude to implement a fix
4. Runs tests
5. Creates a PR

### Exit Criteria

- Successfully create at least 3 PRs on real OSS projects (can be your own test repos initially)
- Cost per issue tracked and displayed
- Handles common failure cases gracefully (tests fail, can't understand issue, etc.)

---

## Phase 2: State Management & Budget Control

**Goal**: Add persistence, budget limits, and operation history.

**Duration estimate**: ~1 week

### Dependencies

- Phase 1 complete

### Tasks

#### 2.1 State Persistence

- [X] Choose storage (SQLite via better-sqlite3 for simplicity)
- [X] Define schema: projects, issues, sessions, issue_transitions, issue_work_records
- [X] Implement StateManager class
- [X] Track issue state transitions with full audit trail

#### 2.2 Budget Manager

- [X] Per-issue budget limits (via config)
- [X] Budget configuration in config file
- [X] Daily/monthly budget tracking (StateManager + BudgetManager)
- [X] Hard stop at budget threshold (IssueProcessor + AutonomousRunner)

#### 2.3 Session Management

- [X] Save session state for resume capability
- [X] Session history and cost breakdown
- [X] Work records tracking (branch, worktree, PR)

#### 2.4 CLI Commands (Phase 2)

- [X] `oss-agent status` - Show current state, active sessions
- [X] `oss-agent history` - List past operations
- [X] `oss-agent resume <session-id>` - Resume interrupted work
- [X] `oss-agent cleanup` - Clean up completed/failed worktrees

### Deliverables

- Persistent storage of all operations
- Budget enforcement that stops work before exceeding limits
- Ability to see "what did the agent do and how much did it cost"

### Exit Criteria

- Agent refuses to work when budget exceeded
- Can resume interrupted session
- Full audit trail of all operations

---

## Phase 3: Feedback Loop & PR Monitoring ✅

**Goal**: Implement the hooks-based feedback loop for iterating on PR feedback.

**Duration estimate**: ~1-2 weeks

**Status**: Core functionality complete - hooks integration, PR monitoring, and feedback parsing implemented.

### Dependencies

- Phase 2 complete

### Tasks

#### 3.1 Claude Code Hooks Integration

- [X] Create hook scripts directory structure (`.claude/hooks/`)
- [X] Implement `session-start.sh` - Inject feedback on resume
- [X] Implement `stop.sh` - Capture PR creation, save state
- [X] Implement `session-end.sh` - Save session state
- [X] Configure hooks in `.claude/settings.json`
- [X] Internal CLI commands for hooks (`internal get-session-context`, `internal register-pr`, etc.)

#### 3.2 Feedback Monitor Service

- [X] Feedback parser for PR comments (FeedbackParser class)
- [X] Classify feedback type (approval, changes_requested, comment, automated)
- [X] Detect automated feedback (Sourcery, CodeRabbit, dependabot, etc.)
- [X] PR monitoring via PRService and StateManager (`monitored_prs` table)
- [X] `oss-agent prs` command to list and check monitored PRs

#### 3.3 Feedback Response Engine ✅

- [X] Parse feedback into actionable items (FeedbackParser.parse() → ActionableFeedback[])
- [X] Generate fix prompt from feedback (IterationHandler.buildIterationPrompt() + FeedbackParser.formatForPrompt())
- [X] Apply fixes and push (IterationHandler.iterate() - AI execution, commit, push)
- [X] Iteration limits and guards (via config maxIterations)

#### 3.4 CLI Commands (Phase 3)

- [X] `oss-agent watch` - Start feedback monitor (placeholder)
- [X] `oss-agent iterate <pr-url>` - Process PR feedback and iterate
- [X] `oss-agent prs` - List PRs being monitored
- [X] `oss-agent internal` - Hidden commands for hooks integration

### Deliverables

- Automatic detection of PR feedback
- Agent can address simple feedback (lint fixes, minor changes)
- Clear logging of feedback received and actions taken

### Exit Criteria

- Successfully iterate on at least 2 PRs based on automated feedback
- Stops after max iterations
- Human notification when intervention needed

---

## Phase 4: Issue Discovery & Selection (OSS Mode) ✅

**Goal**: Implement intelligent issue discovery and prioritization for OSS contributions.

**Duration estimate**: ~1-2 weeks

**Status**: Complete - all functionality implemented including autonomous mode, rate limiting, conflict detection, and queue management.

### Dependencies

- Phase 3 complete

### Tasks

#### 4.1 Project Discovery Service ✅

- [X] Direct mode: Work with explicit repo list
- [X] Search mode: GitHub search by criteria (language, stars, topics)
- [X] Project health scoring (response time, merge rate, activity)
- [X] Automated feedback tool detection

#### 4.2 Issue Selection Service ✅

- [X] Filter modes: unassigned_no_pr, all_open, custom
- [X] Issue scoring algorithm
- [X] "Good first issue" prioritization
- [X] Conflict detection - pre-flight analysis of issue scope (ConflictDetector class)
- [X] Conflict detection - runtime check against in-progress issues

#### 4.3 Fork Management ✅

- [X] RepoService for GitHub operations (checkPermissions, forkRepo, getCurrentUser)
- [X] Automatic fork detection (check push permissions)
- [X] Auto-forking when user lacks push access
- [X] Clone with fork support (upstream + fork remotes)
- [X] Push to fork remote
- [X] PR creation with fork owner prefix (user:branch)

#### 4.4 Queue Management

- [X] Issue queue with priorities (queue command with prioritize subcommand)
- [X] Rate limiting enforcement (RateLimiter class - max PRs per project per day)
- [X] Automatic queue replenishment (QueueManager class)
- [X] Queue configuration (minQueueSize, targetQueueSize, autoReplenish)

#### 4.5 Discovery Filters & Modes

- [X] Domain categories (ai-ml, cybersecurity, devtools, frontend, backend, etc.)
- [X] Framework filter (pytorch, fastapi, react, etc.)
- [X] Curated list parsing (awesome-* lists)
- [X] Enhanced automated feedback tool detection (13+ tools)
- [X] Intelligent mode with AI agent (natural language queries via --intelligent --query)

#### 4.6 CLI Commands (Phase 4)

- [X] `oss-agent discover` - Find projects matching criteria
- [X] `oss-agent suggest` - Suggest issues to work on
- [X] `oss-agent queue` - Show/manage issue queue (list, add, skip, prioritize, clear)
- [X] `oss-agent run` - Autonomous mode (work through queue with rate limiting, conflict detection, auto-replenishment)

### Deliverables

- Can discover interesting OSS projects automatically
- Prioritized queue of issues ready to work on
- Semi-autonomous operation mode

### Exit Criteria

- Successfully discover and rank 20+ projects
- Issue queue populated with 10+ viable issues
- Complete 5 issues in autonomous mode

---

## Phase 5: Parallel Work with Worktrees

**Goal**: Enable working on multiple issues simultaneously using git worktrees.

**Duration estimate**: ~1 week

### Dependencies

- Phase 4 complete

### Tasks

#### 5.1 Worktree Manager

- [X] Create worktrees for parallel issue work
- [X] Branch management per worktree
- [X] Cleanup completed/failed worktrees
- [X] Resource tracking per worktree

#### 5.2 Parallel Agent Orchestration

- [X] Semaphore for max concurrent agents
- [X] Per-project and global limits
- [X] Conflict detection between parallel issues
- [X] Aggregate status reporting

#### 5.3 CLI Commands (Phase 5)

- [X] `oss-agent work-parallel --count N` - Work on N issues in parallel
- [X] `oss-agent parallel-status` - Show parallel work status
- [X] `oss-agent cancel <issue>` - Cancel specific parallel work

### Deliverables

- Work on 3-5 issues simultaneously
- Efficient storage via shared git objects
- Clear visibility into parallel operations

### Exit Criteria

- Successfully run 3 parallel agents on same project
- Conflict detection prevents overlapping work
- Resource limits enforced

---

## Phase 6: B2B Mode - Internal Repository Support ✅

**Goal**: Extend the system to work with private repositories and internal tooling.

**Duration estimate**: ~2-3 weeks

**Status**: Complete - Provider abstraction layer, multi-platform support, and campaign management implemented.

### Dependencies

- Phase 5 complete (full OSS mode working)

### Tasks

#### 6.1 Provider Abstraction Layer

- [X] `RepositoryProvider` interface for multi-platform support
- [X] `IssueSourceProvider` interface for issue tracking systems
- [X] Provider factory with automatic detection
- [X] URL parsing for all supported platforms

#### 6.2 Repository Providers

- [X] GitHub provider (base implementation using `gh` CLI)
- [X] GitHub Enterprise support (custom hostname, API URL)
- [X] GitLab support (using `glab` CLI + REST API fallback)
- [X] Bitbucket support (via MCP tools)

#### 6.3 Issue Source Integrations

- [X] GitHub Issues provider
- [X] Jira integration (REST API, JQL queries, status transitions)
- [X] Linear integration (GraphQL API, state mapping)
- [X] Custom issue source interface

#### 6.4 Campaign Management

- [X] Campaign CRUD operations
- [X] Campaign status lifecycle (draft → active → paused → completed/cancelled)
- [X] Issue queue management with priorities
- [X] Budget tracking and limits
- [X] Campaign progress tracking (total, completed, failed issues)
- [X] Campaign transitions audit log

#### 6.5 CLI Commands (Phase 6)

- [X] `oss-agent campaign list` - List all campaigns
- [X] `oss-agent campaign create <name>` - Create new campaign
- [X] `oss-agent campaign show <id>` - Show campaign details
- [X] `oss-agent campaign add-issues <id> <urls...>` - Add issues to campaign
- [X] `oss-agent campaign start <id>` - Start campaign execution
- [X] `oss-agent campaign pause <id>` - Pause campaign
- [X] `oss-agent campaign resume <id>` - Resume paused campaign
- [X] `oss-agent campaign status <id>` - Show execution progress

### Deliverables

- Work on private repositories via GitHub Enterprise, GitLab, Bitbucket
- Pull issues from Jira/Linear
- Campaign-based batch operations with budget control

### Exit Criteria

- Successfully run campaign on private repo
- Jira/Linear integration working end-to-end
- Campaign progress and budget tracking functional

---

## Phase 7: Advanced Features & Polish

**Goal**: Production hardening, advanced features, better UX.

**Duration estimate**: ~2-3 weeks

### Tasks

#### 7.1 Proactive Issue Discovery

- [ ] Repository auditing (find potential issues)
- [ ] Auto-generate well-written issues
- [ ] Responsible disclosure for security findings

#### 7.2 Dashboard (Optional)

- [ ] Simple web UI for status/configuration
- [ ] Real-time progress view
- [ ] Historical analytics

#### 7.3 MCP Server Mode ✅

- [X] Expose agent capabilities as MCP tools
- [X] Integration with other AI systems
- [X] Stdio transport for Claude Desktop/Code integration
- [X] HTTP/SSE transport with API key authentication
- [X] 19 MCP tools across 6 categories (workflow, discovery, queue, autonomous, monitoring, management)
- [X] 8 MCP resources (config, state, queue)
- [X] Rate limiting middleware for HTTP transport
- [X] `oss-agent serve` CLI command with transport selection
- [X] Circuit breaker and watchdog integration for long-running tools

#### 7.4 Hardening ✅

- [X] Comprehensive error handling (NetworkError, TimeoutError, CircuitOpenError, RateLimitError)
- [X] Retry logic with exponential backoff and jitter (`src/infra/retry.ts`)
- [X] Circuit breaker pattern for cascading failure prevention (`src/infra/circuit-breaker.ts`)
- [X] Watchdog timer for hung AI operations (`src/infra/watchdog.ts`)
- [X] Health checks for long-running operations (`src/infra/health-check.ts`)
- [X] Resource cleanup manager with graceful shutdown (`src/infra/cleanup-manager.ts`)
- [X] Integration into AI providers, git operations, and engine components
- [X] Unit tests for all hardening infrastructure (91 tests)

### Exit Criteria

- System runs reliably for extended periods
- Clear error messages and recovery
- Documentation complete

---

## Milestone Summary

| Milestone                        | Phases | Key Capability                            | Status      |
| -------------------------------- | ------ | ----------------------------------------- | ----------- |
| **M1: First PR**           | 0-1    | Can create a PR from an issue URL         | ✅ Complete |
| **M2: Reliable Operation** | 2      | Budget control, state persistence, resume | ✅ Complete |
| **M3: Feedback Loop**      | 3      | Iterate on PR feedback automatically      | ✅ Complete |
| **M4: Autonomous OSS**     | 4-5    | Discover issues, work in parallel         | ✅ Complete |
| **M5: B2B Ready**          | 6      | Private repos, Jira/Linear, campaigns     | ✅ Complete |
| **M6: Production**         | 7      | Hardened, documented, polished            | ✅ Complete |

---

## Risk Mitigation

### Technical Risks

| Risk                            | Mitigation                                            |
| ------------------------------- | ----------------------------------------------------- |
| Claude Agent SDK limitations    | Have fallback to direct API calls                     |
| Git conflicts in parallel work  | Conservative conflict detection, abort on uncertainty |
| Rate limiting (GitHub, AI APIs) | Built-in rate limiting, exponential backoff           |

### Product Risks

| Risk                  | Mitigation                                             |
| --------------------- | ------------------------------------------------------ |
| PRs perceived as spam | Strict quality gates, limits per repo, "draft PR" mode |
| Poor PR quality       | Test requirement, lint checks, iteration on feedback   |
| Runaway costs         | Hard budget stops, per-issue caps, daily limits        |

---

## Next Steps

1. ~~Complete Phase 0 setup~~ ✅
2. ~~Start Phase 1 with AI Provider abstraction~~ ✅
3. ~~Begin dogfooding immediately once basic flow works~~ ✅
4. ~~Complete Phase 2: State Management & Budget Control~~ ✅
5. ~~Complete Phase 3: Feedback Loop & PR Monitoring~~ ✅
6. ~~Complete Phase 4: Issue Discovery & Selection~~ ✅
7. ~~Complete Phase 5: Parallel Work with Worktrees~~ ✅
8. ~~Complete Phase 6: B2B Mode~~ ✅
9. ~~Complete Phase 7.3: MCP Server Mode~~ ✅
10. ~~Complete Phase 7.4: Hardening~~ ✅
11. **Next**: Phase 7.1 Proactive Issue Discovery (optional), Phase 7.2 Dashboard (optional)
