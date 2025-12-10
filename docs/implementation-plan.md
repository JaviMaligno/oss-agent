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

- [ ] Initialize TypeScript project with strict configuration
- [ ] Set up ESLint, Prettier, and pre-commit hooks
- [ ] Configure testing framework (Vitest)
- [ ] Set up project structure following module-structure.md
- [ ] Create basic CLI skeleton with Commander.js
- [ ] Set up environment variable handling (dotenv + zod validation)
- [ ] Initialize git repository with conventional commits

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

- [ ] Define `AIProvider` interface
- [ ] Implement `ClaudeProvider` using Claude Agent SDK
- [ ] Basic prompt construction for code tasks
- [ ] Cost tracking per query

#### 1.2 Git Operations Manager

- [ ] Clone/fetch repository
- [ ] Branch creation with naming conventions
- [ ] Commit with conventional commit format
- [ ] Basic conflict detection

#### 1.3 Contribution Engine (MVP)

- [ ] Issue parsing (extract title, body, labels from URL)
- [ ] Context gathering (read relevant files, CONTRIBUTING.md)
- [ ] Implementation prompt generation
- [ ] Code modification execution
- [ ] Basic test running (detect and run test command)

#### 1.4 PR Creation

- [ ] Generate PR title and description from issue
- [ ] Create PR via GitHub CLI (`gh`)
- [ ] Link PR to issue

#### 1.5 CLI Commands (Phase 1)

- [ ] `oss-agent work <issue-url>` - Full flow for single issue
- [ ] `oss-agent config` - Set API keys, preferences
- [ ] Basic progress output during execution

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

- [ ] Choose storage (SQLite via better-sqlite3 for simplicity)
- [ ] Define schema: projects, issues, sessions, audit_log
- [ ] Implement StateManager class
- [ ] Track issue state transitions

#### 2.2 Budget Manager

- [ ] Per-issue budget limits
- [ ] Daily/monthly budget tracking
- [ ] Hard stop at budget threshold
- [ ] Budget status reporting

#### 2.3 Session Management

- [ ] Save session state for resume capability
- [ ] Session history and cost breakdown
- [ ] Clean up old sessions

#### 2.4 CLI Commands (Phase 2)

- [ ] `oss-agent status` - Show current state, budget usage
- [ ] `oss-agent history` - List past operations
- [ ] `oss-agent resume <session-id>` - Resume interrupted work

### Deliverables

- Persistent storage of all operations
- Budget enforcement that stops work before exceeding limits
- Ability to see "what did the agent do and how much did it cost"

### Exit Criteria

- Agent refuses to work when budget exceeded
- Can resume interrupted session
- Full audit trail of all operations

---

## Phase 3: Feedback Loop & PR Monitoring

**Goal**: Implement the hooks-based feedback loop for iterating on PR feedback.

**Duration estimate**: ~1-2 weeks

### Dependencies

- Phase 2 complete

### Tasks

#### 3.1 Claude Code Hooks Integration

- [ ] Create hook scripts directory structure
- [ ] Implement `on-session-stop.sh` - Capture PR creation, save state
- [ ] Implement `on-session-start.sh` - Inject feedback on resume
- [ ] Implement `on-pr-created.sh` - Register PR for monitoring

#### 3.2 Feedback Monitor Service

- [ ] PR polling mechanism (GitHub API via `gh`)
- [ ] Detect new comments (human and bot)
- [ ] Classify feedback type (approval, changes requested, comment)
- [ ] Detect automated feedback (Sourcery, CodeRabbit, etc.)

#### 3.3 Feedback Response Engine

- [ ] Parse feedback into actionable items
- [ ] Generate fix prompt from feedback
- [ ] Apply fixes and push
- [ ] Iteration limits and guards

#### 3.4 CLI Commands (Phase 3)

- [ ] `oss-agent watch` - Start feedback monitor
- [ ] `oss-agent prs` - List PRs being monitored
- [ ] `oss-agent respond <pr-url>` - Manually trigger feedback response

### Deliverables

- Automatic detection of PR feedback
- Agent can address simple feedback (lint fixes, minor changes)
- Clear logging of feedback received and actions taken

### Exit Criteria

- Successfully iterate on at least 2 PRs based on automated feedback
- Stops after max iterations
- Human notification when intervention needed

---

## Phase 4: Issue Discovery & Selection (OSS Mode)

**Goal**: Implement intelligent issue discovery and prioritization for OSS contributions.

**Duration estimate**: ~1-2 weeks

### Dependencies

- Phase 3 complete

### Tasks

#### 4.1 Project Discovery Service

- [ ] Direct mode: Work with explicit repo list
- [ ] Search mode: GitHub search by criteria (language, stars, topics)
- [ ] Project health scoring (response time, merge rate, activity)
- [ ] Automated feedback tool detection

#### 4.2 Issue Selection Service

- [ ] Filter modes: unassigned_no_pr, all_open, custom
- [ ] Issue scoring algorithm
- [ ] "Good first issue" prioritization
- [ ] Conflict detection (issues that might touch same files)

#### 4.3 Queue Management

- [ ] Issue queue with priorities
- [ ] Rate limiting (max PRs per project per day)
- [ ] Automatic queue replenishment

#### 4.4 CLI Commands (Phase 4)

- [ ] `oss-agent discover` - Find projects matching criteria
- [ ] `oss-agent suggest` - Suggest issues to work on
- [ ] `oss-agent queue` - Show/manage issue queue
- [ ] `oss-agent run` - Autonomous mode (work through queue)

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

- [ ] Create worktrees for parallel issue work
- [ ] Branch management per worktree
- [ ] Cleanup completed/failed worktrees
- [ ] Resource tracking per worktree

#### 5.2 Parallel Agent Orchestration

- [ ] Semaphore for max concurrent agents
- [ ] Per-project and global limits
- [ ] Conflict detection between parallel issues
- [ ] Aggregate status reporting

#### 5.3 CLI Commands (Phase 5)

- [ ] `oss-agent work-parallel --count N` - Work on N issues in parallel
- [ ] `oss-agent parallel-status` - Show parallel work status
- [ ] `oss-agent cancel <issue>` - Cancel specific parallel work

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

| Milestone | Phases | Key Capability |
|-----------|--------|----------------|
| **M1: First PR** | 0-1 | Can create a PR from an issue URL |
| **M2: Reliable Operation** | 2 | Budget control, state persistence, resume |
| **M3: Feedback Loop** | 3 | Iterate on PR feedback automatically |
| **M4: Autonomous OSS** | 4-5 | Discover issues, work in parallel |
| **M5: B2B Ready** | 6 | Private repos, Jira, campaigns |
| **M6: Production** | 7 | Hardened, documented, polished |

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

1. Complete Phase 0 setup
2. Start Phase 1 with AI Provider abstraction
3. Begin dogfooding immediately once basic flow works
