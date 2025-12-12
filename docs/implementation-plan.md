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

- [x] Initialize TypeScript project with strict configuration
- [x] Set up ESLint, Prettier, and pre-commit hooks
- [x] Configure testing framework (Vitest)
- [x] Set up project structure following module-structure.md
- [x] Create basic CLI skeleton with Commander.js
- [x] Set up environment variable handling (dotenv + zod validation)
- [x] Initialize git repository with conventional commits

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

- [x] Define `AIProvider` interface
- [x] Implement `ClaudeCLIProvider` using Claude CLI (`--print` mode)
- [x] Basic prompt construction for code tasks
- [x] Cost tracking per query (partial - turns tracked, cost not reported by CLI)

#### 1.2 Git Operations Manager

- [x] Clone/fetch repository
- [x] Branch creation with naming conventions
- [x] Commit with conventional commit format
- [x] Git worktree support for isolated work
- [x] Fork detection and auto-forking for upstream repos

#### 1.3 Contribution Engine (MVP)

- [x] Issue parsing (extract title, body, labels from URL)
- [x] Implementation prompt generation
- [x] Code modification execution via Claude CLI
- [x] Quality gates (max files, max lines changed)

#### 1.4 PR Creation

- [x] Generate PR title and description from issue
- [x] Create PR via GitHub CLI (`gh`)
- [x] Link PR to issue
- [x] Fork-based PR creation (user:branch format)

#### 1.5 CLI Commands (Phase 1)

- [x] `oss-agent work <issue-url>` - Full flow for single issue
- [x] `oss-agent config` - View/edit configuration
- [x] Basic progress output during execution (step indicators)

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

- [x] Choose storage (SQLite via better-sqlite3 for simplicity)
- [x] Define schema: projects, issues, sessions, issue_transitions, issue_work_records
- [x] Implement StateManager class
- [x] Track issue state transitions with full audit trail

#### 2.2 Budget Manager

- [x] Per-issue budget limits (via config)
- [x] Budget configuration in config file
- [x] Daily/monthly budget tracking (StateManager + BudgetManager)
- [x] Hard stop at budget threshold (IssueProcessor + AutonomousRunner)

#### 2.3 Session Management

- [x] Save session state for resume capability
- [x] Session history and cost breakdown
- [x] Work records tracking (branch, worktree, PR)

#### 2.4 CLI Commands (Phase 2)

- [x] `oss-agent status` - Show current state, active sessions
- [x] `oss-agent history` - List past operations
- [x] `oss-agent resume <session-id>` - Resume interrupted work
- [x] `oss-agent cleanup` - Clean up completed/failed worktrees

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

- [x] Create hook scripts directory structure (`.claude/hooks/`)
- [x] Implement `session-start.sh` - Inject feedback on resume
- [x] Implement `stop.sh` - Capture PR creation, save state
- [x] Implement `session-end.sh` - Save session state
- [x] Configure hooks in `.claude/settings.json`
- [x] Internal CLI commands for hooks (`internal get-session-context`, `internal register-pr`, etc.)

#### 3.2 Feedback Monitor Service

- [x] Feedback parser for PR comments (FeedbackParser class)
- [x] Classify feedback type (approval, changes_requested, comment, automated)
- [x] Detect automated feedback (Sourcery, CodeRabbit, dependabot, etc.)
- [x] PR monitoring via PRService and StateManager (`monitored_prs` table)
- [x] `oss-agent prs` command to list and check monitored PRs

#### 3.3 Feedback Response Engine ✅

- [x] Parse feedback into actionable items (FeedbackParser.parse() → ActionableFeedback[])
- [x] Generate fix prompt from feedback (IterationHandler.buildIterationPrompt() + FeedbackParser.formatForPrompt())
- [x] Apply fixes and push (IterationHandler.iterate() - AI execution, commit, push)
- [x] Iteration limits and guards (via config maxIterations)

#### 3.4 CLI Commands (Phase 3)

- [x] `oss-agent watch` - Start feedback monitor (placeholder)
- [x] `oss-agent iterate <pr-url>` - Process PR feedback and iterate
- [x] `oss-agent prs` - List PRs being monitored
- [x] `oss-agent internal` - Hidden commands for hooks integration

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

- [x] Direct mode: Work with explicit repo list
- [x] Search mode: GitHub search by criteria (language, stars, topics)
- [x] Project health scoring (response time, merge rate, activity)
- [x] Automated feedback tool detection

#### 4.2 Issue Selection Service ✅

- [x] Filter modes: unassigned_no_pr, all_open, custom
- [x] Issue scoring algorithm
- [x] "Good first issue" prioritization
- [x] Conflict detection - pre-flight analysis of issue scope (ConflictDetector class)
- [x] Conflict detection - runtime check against in-progress issues

#### 4.3 Fork Management ✅

- [x] RepoService for GitHub operations (checkPermissions, forkRepo, getCurrentUser)
- [x] Automatic fork detection (check push permissions)
- [x] Auto-forking when user lacks push access
- [x] Clone with fork support (upstream + fork remotes)
- [x] Push to fork remote
- [x] PR creation with fork owner prefix (user:branch)

#### 4.4 Queue Management

- [x] Issue queue with priorities (queue command with prioritize subcommand)
- [x] Rate limiting enforcement (RateLimiter class - max PRs per project per day)
- [x] Automatic queue replenishment (QueueManager class)
- [x] Queue configuration (minQueueSize, targetQueueSize, autoReplenish)

#### 4.5 Discovery Filters & Modes

- [x] Domain categories (ai-ml, cybersecurity, devtools, frontend, backend, etc.)
- [x] Framework filter (pytorch, fastapi, react, etc.)
- [x] Curated list parsing (awesome-* lists)
- [x] Enhanced automated feedback tool detection (13+ tools)
- [x] Intelligent mode with AI agent (natural language queries via --intelligent --query)

#### 4.6 CLI Commands (Phase 4)

- [x] `oss-agent discover` - Find projects matching criteria
- [x] `oss-agent suggest` - Suggest issues to work on
- [x] `oss-agent queue` - Show/manage issue queue (list, add, skip, prioritize, clear)
- [x] `oss-agent run` - Autonomous mode (work through queue with rate limiting, conflict detection, auto-replenishment)

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

- [x] Create worktrees for parallel issue work
- [x] Branch management per worktree
- [x] Cleanup completed/failed worktrees
- [x] Resource tracking per worktree

#### 5.2 Parallel Agent Orchestration

- [x] Semaphore for max concurrent agents
- [x] Per-project and global limits
- [x] Conflict detection between parallel issues
- [x] Aggregate status reporting

#### 5.3 CLI Commands (Phase 5)

- [x] `oss-agent work-parallel --count N` - Work on N issues in parallel
- [x] `oss-agent parallel-status` - Show parallel work status
- [x] `oss-agent cancel <issue>` - Cancel specific parallel work

### Deliverables

- Work on 3-5 issues simultaneously
- Efficient storage via shared git objects
- Clear visibility into parallel operations

### Exit Criteria

- Successfully run 3 parallel agents on same project
- Conflict detection prevents overlapping work
- Resource limits enforced

---

## Phase 6: B2B Mode - Internal Repository Support

**Goal**: Extend the system to work with private repositories and internal tooling.

**Duration estimate**: ~2-3 weeks

### Dependencies

- Phase 5 complete (full OSS mode working)

### Tasks

#### 6.1 Authentication & Access

- [ ] GitHub Enterprise support
- [ ] GitLab support (via MCP or API)
- [ ] Bitbucket support (MCP already available)
- [ ] Credential management for multiple providers

#### 6.2 Issue Source Integrations

- [ ] Jira integration (read issues, update status)
- [ ] Linear integration
- [ ] Sentry integration (errors as issues)
- [ ] Custom issue source interface

#### 6.3 Campaign Management

- [ ] Define campaign (criteria, scope, limits)
- [ ] Campaign progress tracking
- [ ] Reporting (issues closed, PRs merged, cost)

#### 6.4 CLI Commands (Phase 6)

- [ ] `oss-agent campaign create` - Define a new campaign
- [ ] `oss-agent campaign run <id>` - Execute campaign
- [ ] `oss-agent campaign status <id>` - Campaign progress
- [ ] `oss-agent report` - Generate reports

### Deliverables

- Work on private repositories
- Pull issues from Jira/Linear
- Campaign-based batch operations

### Exit Criteria

- Successfully run campaign on private repo
- Jira integration working end-to-end
- Generate meaningful campaign report

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

#### 7.3 MCP Server Mode

- [ ] Expose agent capabilities as MCP tools
- [ ] Integration with other AI systems

#### 7.4 Hardening

- [ ] Comprehensive error handling
- [ ] Retry logic with backoff
- [ ] Graceful shutdown
- [ ] Health checks

### Exit Criteria

- System runs reliably for extended periods
- Clear error messages and recovery
- Documentation complete

---

## Milestone Summary

| Milestone | Phases | Key Capability | Status |
|-----------|--------|----------------|--------|
| **M1: First PR** | 0-1 | Can create a PR from an issue URL | ✅ Complete |
| **M2: Reliable Operation** | 2 | Budget control, state persistence, resume | ✅ Complete |
| **M3: Feedback Loop** | 3 | Iterate on PR feedback automatically | ✅ Complete |
| **M4: Autonomous OSS** | 4-5 | Discover issues, work in parallel | ✅ Complete |
| **M5: B2B Ready** | 6 | Private repos, Jira, campaigns | 🔜 Pending |
| **M6: Production** | 7 | Hardened, documented, polished | 🔜 Pending |

---

## Risk Mitigation

### Technical Risks

| Risk | Mitigation |
|------|------------|
| Claude Agent SDK limitations | Have fallback to direct API calls |
| Git conflicts in parallel work | Conservative conflict detection, abort on uncertainty |
| Rate limiting (GitHub, AI APIs) | Built-in rate limiting, exponential backoff |

### Product Risks

| Risk | Mitigation |
|------|------------|
| PRs perceived as spam | Strict quality gates, limits per repo, "draft PR" mode |
| Poor PR quality | Test requirement, lint checks, iteration on feedback |
| Runaway costs | Hard budget stops, per-issue caps, daily limits |

---

## Next Steps

1. ~~Complete Phase 0 setup~~ ✅
2. ~~Start Phase 1 with AI Provider abstraction~~ ✅
3. ~~Begin dogfooding immediately once basic flow works~~ ✅
4. ~~Complete Phase 2: State Management & Budget Control~~ ✅
5. ~~Complete Phase 3: Feedback Loop & PR Monitoring~~ ✅
6. ~~Complete Phase 4: Issue Discovery & Selection~~ ✅
7. ~~Complete Phase 5: Parallel Work with Worktrees~~ ✅
8. **Next**: Begin Phase 6 (B2B Mode) or Phase 7 (Advanced Features)
