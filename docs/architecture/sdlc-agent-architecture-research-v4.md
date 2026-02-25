# SDLC Agent Architecture on the Claude Agent SDK

## Research Report — February 2026 (v4)

> **Changelog**
> - **v4**: Changed frontend framework from React to Svelte. Rationale: the frontend is a secondary concern in this project — the core innovation is in the agent coordination layer. Svelte's fine-grained reactivity (no virtual DOM diffing), lower boilerplate, and built-in stores reduce wiring code compared to React, which matters for Phase 2–3 when the UI handles streaming output from multiple concurrent agents and complex state across agent sessions. React's ecosystem advantages (component libraries, hiring pool) are less relevant for a personal project where Claude Code writes most of the frontend. Tauri has first-class Svelte template support. This is a low-risk, reversible decision — the frontend sits behind Tauri's IPC boundary and the agent/backend layers are unaffected. Updated: Executive Summary, Architecture Overview diagram (2.3), Communication flow (2.3), Mitigating Rust Learning Curve (2.4), Implementation Roadmap Phase 1 (10), Summary of Recommendations (13), Alternatives Considered (12.6).
> - **v3**: Added UX/Design Agent — full definition in Section 3.6, integrated into hierarchy diagram (3.2), agent table (3.4), sequential pipeline (3.5), and standards tree (4.2). Updated Planning Coordinator description. Platform now covers full-stack product development.
> - **v2**: Initial research document.

---

## Executive Summary

This document presents research findings on building an SDLC (Software Development Lifecycle) management application powered by the Claude Agent SDK. The architecture uses specialized agents for each development phase, a **reference-based handoff protocol** for inter-agent context transfer, a **standards-first agent definition model**, and a **local-first memory and audit layer** backed by SQLite.

Key architectural decisions:

- **Claude Agent SDK (TypeScript)** — full agent harness with subagents, hooks, MCP, session persistence
- **Tauri 2.0 desktop shell** — lightweight Rust backend for storage and process management, Svelte/TypeScript frontend
- **Hybrid coordinator pattern** — hierarchical supervision with shared memory (blackboard) for cross-agent knowledge
- **Reference-based handoffs** — agents receive URI manifests pointing to living documents, not summaries (a novel pattern not found in existing frameworks)
- **Work hierarchy** — Initiative → Epic → Issue mapping to issue tracking systems, with documentation-based traceability when trackers lack hierarchy
- **Agent identity model** — scoped credentials with delegation chains, designed for future FIDO-like cryptographic extension
- **Audit trail** — abstracted append-only event log capturing agent lifecycle, actions, and decisions
- **Standards-first definitions** — three-tier standards model (system defaults → project overrides → agent-specific) baked into agent identities
- **Semantic search as additive layer** — deferred; start with FTS5 keyword search and explicit references, add vector embeddings when project scale warrants it

---

## 1. The Claude Agent SDK — What You're Building On

### 1.1 Overview

The Claude Agent SDK (formerly the Claude Code SDK, renamed September 2025) is the same agent harness that powers Claude Code — now available as a standalone library in both **Python** and **TypeScript**. It provides:

- **Built-in tools**: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch
- **Subagents**: Isolated agent instances with their own context windows, system prompts, and tool permissions — spawnable in parallel
- **Hooks**: Intercept and control behavior at key lifecycle points (PreToolUse, PostToolUse, SessionStart, SessionEnd, etc.)
- **MCP integration**: Connect to external tools via Model Context Protocol servers (stdio, HTTP, or in-process)
- **Custom tools**: Define your own tools as in-process MCP servers — no separate process needed
- **Session management**: Persist and resume sessions, with automatic context compaction
- **File checkpointing**: Snapshot file state for rollback capability
- **Permissions**: Fine-grained allow/deny/ask rules per tool, with hook-based overrides

### 1.2 SDK Architecture for This Project

The TypeScript SDK is the recommended choice because:

1. It supports **SessionStart/SessionEnd hooks** (Python SDK does not)
2. It integrates naturally with a Tauri frontend (both TypeScript)
3. The `createSdkMcpServer` function lets you define custom tools inline
4. Session resume via `sessionId` enables persistent agent conversations

**Key SDK pattern — defining a specialized agent:**

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

const result = query({
  prompt: "Review the authentication module for security issues",
  options: {
    agents: {
      'security-reviewer': {
        description: 'Expert security review specialist. Use for vulnerability analysis.',
        prompt: `You are a security review specialist. When reviewing code:
          - Identify OWASP Top 10 vulnerabilities
          - Check for injection points
          - Verify authentication flows`,
        tools: ['Read', 'Grep', 'Glob'],
        model: 'sonnet'
      }
    }
  }
});
```

### 1.3 Key Capabilities for SDLC Agents

| Capability | SDK Feature | SDLC Use |
|---|---|---|
| Isolated context | Subagents | Each SDLC phase agent gets its own context window |
| Parallel execution | Subagent spawning | Run code review + security scan + test analysis simultaneously |
| Tool restriction | `allowedTools` per agent | QA agents can't write code; code agents can't deploy |
| Custom tools | `createSdkMcpServer` | Memory read/write, issue tracking, CI/CD triggers |
| Lifecycle hooks | PreToolUse/PostToolUse | Audit logging, scope enforcement, memory sync |
| Session persistence | `resume: sessionId` | Continue agent conversations across app sessions |
| Structured output | SDK structured outputs | Enforce JSON schemas for reference manifests and handoffs |
| Identity enforcement | PreToolUse hooks | Validate agent scope before every tool invocation |

### 1.4 Why Only Python/TypeScript SDKs

The SDK is not a typical API client — it wraps the Claude CLI binary. When calling `query()`, the SDK spawns a Claude CLI subprocess (Node.js-based) and communicates via stdio. This architectural choice limits SDK availability to Python and TypeScript because the SDK is a process manager, not an HTTP client. Other languages integrate via MCP servers over stdio transport — write tools in Rust, Go, or C# as MCP servers that agents can call.

For this project, the Rust backend doesn't need the SDK directly. It orchestrates TypeScript agent processes and provides services (memory, audit, file system) via MCP.

---

## 2. Desktop Framework: Tauri 2.0

### 2.1 Framework Comparison

| Criteria | Electron | Tauri 2.0 | Verdict |
|---|---|---|---|
| **Bundle size** | 80–150 MB (bundles Chromium) | 3–10 MB (uses system WebView) | **Tauri** |
| **Memory (idle)** | 150–300 MB | 30–50 MB | **Tauri** |
| **Startup time** | 1–2 seconds | < 0.5 seconds | **Tauri** |
| **Backend language** | Node.js / JavaScript | Rust | **Tauri** (for this use case) |
| **Frontend** | Any web framework | Any web framework | Tie |
| **Ecosystem maturity** | Massive (Slack, VS Code, Discord) | Growing rapidly (70k+ GitHub stars) | Electron |
| **Cross-platform** | Windows, macOS, Linux | Windows, macOS, Linux, iOS, Android | **Tauri** |
| **Security** | Requires hardening | Capability-based, secure by default | **Tauri** |
| **Learning curve** | JS-only team friendly | Requires some Rust for backend | Electron |
| **WebView consistency** | Chromium everywhere (identical) | System WebView (minor rendering differences) | Electron |

### 2.2 Why Tauri for This Project

**Tauri 2.0 is the recommended choice** for several reasons:

1. **Resource efficiency matters**: An SDLC orchestrator will run multiple agent processes simultaneously. Electron's 300 MB baseline memory + Chromium per window would compound quickly. Tauri's 30–50 MB footprint leaves headroom for the actual agent work.

2. **Rust backend for storage layers**: Tauri's Rust core is ideal for implementing the memory store, audit trail, and process management. SQLite operations, file I/O, and agent subprocess lifecycle management run without blocking the UI.

3. **Security-first**: Tauri's capability-based permission model aligns well with an agent orchestrator where you want explicit control over what each component can access.

4. **Mobile path**: Tauri 2.0 supports iOS/Android. A mobile companion for monitoring SDLC status or approving agent actions is a future possibility.

5. **Claude Agent SDK as a sidecar**: The TypeScript SDK runs the Claude CLI under the hood. Tauri's sidecar pattern lets you bundle and manage this process cleanly.

### 2.3 Architecture Overview

```
┌─────────────────────────────────────────────┐
│  Tauri Desktop App                          │
│ ┌─────────────────────────────────────────┐ │
│ │  Frontend (Svelte + TypeScript)         │ │
│ │  - Agent dashboard / status             │ │
│ │  - SDLC pipeline visualization          │ │
│ │  - Memory & audit inspector             │ │
│ │  - Approval workflows                   │ │
│ │  - Standards management UI              │ │
│ └────────────────┬────────────────────────┘ │
│                  │ IPC (invoke)              │
│ ┌────────────────┴────────────────────────┐ │
│ │  Rust Backend (Tauri Core)              │ │
│ │  - Agent process manager                │ │
│ │  - Memory store (SQLite + FTS5)         │ │
│ │  - Audit store (SQLite or JSONL)        │ │
│ │  - Reference resolver                   │ │
│ │  - Identity & scope enforcement         │ │
│ │  - Session persistence                  │ │
│ └────────────────┬────────────────────────┘ │
│                  │ stdio/spawn               │
│ ┌────────────────┴────────────────────────┐ │
│ │  Agent Layer (TypeScript SDK)           │ │
│ │  - Coordinator agents                   │ │
│ │  - SDLC specialist agents (subagents)   │ │
│ │  - Custom MCP tools                     │ │
│ │  - Issue tracking MCP integration       │ │
│ └─────────────────────────────────────────┘ │
└─────────────────────────────────────────────┘
```

**Communication flow:**
- Frontend calls Rust backend via Tauri's `invoke()` IPC
- Rust backend spawns/manages TypeScript agent processes
- Agents communicate with memory/audit layers via custom MCP tools that call back into Rust
- Rust backend pushes status updates to frontend via Tauri events (`emit`)
- Issue tracker and source control integration via dedicated MCP servers

### 2.4 Mitigating the Rust Learning Curve

- **Minimal Rust surface**: Most business logic lives in the TypeScript agent layer. Rust handles storage, process management, and IPC — well-defined, stable code that doesn't change often.
- **Use Tauri plugins**: Many common needs (file system, SQLite, HTTP, shell) have existing Tauri plugins.
- **Tauri's `tauri-plugin-sql`**: Provides SQLite access from both Rust and the frontend, reducing custom Rust code.
- **Claude Code itself**: Use Claude Code to help write and iterate on the Rust components.

---

## 3. Agent Architecture: Hybrid Coordinator Model

### 3.1 Pattern Analysis

Three primary multi-agent orchestration patterns were evaluated:

**Hierarchical (Supervisor)**
- A central "PM Agent" decomposes tasks and delegates to specialist agents
- Strengths: Strong control, clear accountability, good for sequential workflows
- Weaknesses: Supervisor becomes a bottleneck, context window fills up, single point of failure

**Pipeline (Sequential Handoff)**
- Agents pass work product to the next agent in a defined sequence
- Strengths: Simple, predictable, easy to debug
- Weaknesses: No parallelism, rigid, can't handle tasks that don't follow the linear flow

**Blackboard (Shared Memory)**
- Agents read/write to a shared workspace; a meta-agent decides who runs next
- Strengths: Flexible, supports parallel work, agents can self-organize
- Weaknesses: Complex coordination, risk of conflicts, harder to debug

### 3.2 Recommended: Hybrid Coordinator Model

The recommended architecture combines elements of all three, with a **work hierarchy** mapping to issue tracking:

```
                    ┌──────────────────┐
                    │  PM Coordinator  │  Creates Initiatives
                    │  Agent           │
                    └────────┬─────────┘
                             │
              ┌──────────────┼──────────────┐
              │              │              │
     ┌────────┴───┐  ┌──────┴─────┐  ┌────┴────────┐
     │ Planning   │  │ Build      │  │ Release     │  Creates Epics
     │ Coordinator│  │ Coordinator│  │ Coordinator │
     └──────┬─────┘  └──────┬─────┘  └──────┬──────┘
            │               │               │
     ┌──────┴──────┐  ┌────┴─────────┐  ┌──┴──────┐
     │Requirements │  │Code  │Test   │  │Deploy   │  Works on Issues
     │UX Agent     │  │Agent │Agent  │  │Monitor  │
     │Architect    │  │Sec.  │      │  │         │
     │Doc Spec.    │  │      │      │  │         │
     └─────────────┘  └──────┴───────┘  └─────────┘
                             │
                    ┌────────┴────────┐
                    │  Shared Memory  │  (Blackboard)
                    │  + Audit Trail  │
                    └─────────────────┘
```

### 3.3 Work Hierarchy: Initiative → Epic → Issue

The agent hierarchy maps directly to a work tracking hierarchy:

| Agent Level | Work Artifact | Tracker Concept | Example |
|---|---|---|---|
| **PM Coordinator** | Initiative | GitHub Project / Jira Initiative | "Build user authentication system" |
| **Phase Coordinator** | Epic | GitHub Milestone / Jira Epic | "Implement OAuth2 flow" |
| **Specialist Agent** | Issue | GitHub Issue / Jira Story | "Create token refresh endpoint" |

**The issue tracker is the source of truth for work structure.** The agents create and update work items in the tracker via MCP. The memory layer tracks context and decisions; the tracker tracks what needs to be done and its status.

**For trackers without three-tier hierarchy:** The documentation traceability chain (see Section 5.4) provides the linkage. Every artifact (ADR, PR, test plan) carries issue IDs in its References section, allowing reconstruction of the full hierarchy regardless of tracker capabilities. At a minimum, a consistent naming convention or label taxonomy bridges the gap.

### 3.4 SDLC Agent Definitions

| Agent | Role | Tools | Work Output | Standards Applied |
|---|---|---|---|---|
| **PM Coordinator** | Decomposes goals, manages phases, resolves conflicts | Read, Memory, Tracker | Initiatives, phase assignments | Process standards |
| **Planning Coordinator** | Manages requirements, UX, and design | Read, Memory, WebSearch, Tracker | Epics, requirements docs, UX routing decisions | Documentation standards |
| **Requirements Agent** | Elicits and structures requirements | Read, WebSearch, Memory | User stories, acceptance criteria | Issue format, documentation |
| **UX Agent** | Designs user flows, interaction patterns, and component contracts | Read, Write, WebSearch, Memory | User flows, component contracts, interaction specs, accessibility review | UX documentation standards, accessibility checklist, design system conventions |
| **Architect Agent** | Designs system architecture | Read, Grep, Memory | ADRs, component specs | ADR format, documentation |
| **Build Coordinator** | Manages implementation and testing | Read, Bash, Memory, Tracker | Epics, dependency tracking | Process standards |
| **Code Agent** | Writes and refactors code | Read, Write, Edit, Bash, Grep | Source code, implementation notes | Language coding standards, commit conventions |
| **Test Agent** | Writes and runs tests | Read, Write, Bash, Grep | Test suites, coverage reports | Testing requirements |
| **Security Agent** | Reviews code for vulnerabilities | Read, Grep, Glob | Security findings, remediation | Security checklist |
| **Documentation Specialist** | Validates and maintains documentation quality | Read, Grep, Memory, Tracker | Doc reviews, changelogs | All documentation standards |
| **Release Coordinator** | Manages deployment and monitoring | Read, Bash, Memory, Tracker | Release plans, deployment status | Process standards |
| **Deploy Agent** | Executes deployments | Bash, Read | Deployment logs | Deployment checklist |
| **Monitor Agent** | Watches for issues post-deploy | Read, WebFetch, Bash | Incident reports, performance data | Incident format |

The **Documentation Specialist** is a cross-cutting agent that validates documentation produced by all other agents against project standards. It reviews artifacts for completeness, proper formatting, traceability links, and adherence to conventions. It can also generate changelogs and summaries by querying the audit trail.

The **UX Agent** bridges user needs and technical implementation. It sits under the Planning Coordinator alongside the Requirements Agent and Architect Agent, operating after requirements are established and before (or in parallel with) architecture. Its outputs — user flow documents, component contracts, and interaction specifications — become primary references for the Code Agent when implementing user-facing work and for the Test Agent when writing interaction and accessibility tests.

### 3.6 UX Agent: Full Definition

**Role**: UX/Design Specialist
**Coordinator**: Planning Coordinator
**Peers**: Requirements Agent, Architect Agent
**Model**: Sonnet

#### Responsibilities

- Translate user stories into interaction flows and task sequences with decision branches and error paths
- Define component contracts: what a UI component must do, what data it requires, what states it must handle (loading, error, empty, populated)
- Specify accessibility requirements per WCAG 2.1 AA at the component level
- Document design system compliance — which existing components to use, when a new pattern is warranted and why
- Flag interaction complexity early (flows requiring non-trivial state management, animations, or real-time updates) so the Architect Agent can account for them in system design
- Review implemented UI against interaction specs during a post-implementation pass

#### What It Does Not Do

- Produce visual design files (Figma, Sketch, etc.) — it works in structured markdown and YAML, not design tools
- Make backend architecture decisions — it defines the data shape the UI needs and hands that contract to the Architect Agent
- Write code — its outputs are specifications that the Code Agent implements

#### Agent Identity Schema

```typescript
const uxAgent: AgentDefinition = {
  role: "ux-agent",
  description: "UX/Design specialist. Use for user flows, interaction specs, component contracts, and accessibility review.",
  systemPrompt: `You are a UX/design specialist focused on full-stack product work.
    Your outputs are specifications that other agents implement — not visual designs or code.

    When working on a feature:
    - Translate requirements into clear interaction flows with decision branches and error paths
    - Define component contracts in structured markdown or YAML
    - Specify accessibility requirements (WCAG 2.1 AA) at the component level
    - Reference the project design system; prefer existing patterns over new ones
    - Flag complexity that will affect architecture (real-time state, animations, multi-step flows)

    Your work must carry full traceability references (Initiative, Epic, Issue).
    Every document you produce must include a ## References section.`,
  tools: ["Read", "Write", "WebSearch", "Memory"],
  model: "sonnet",
  standards: [
    "documentation-standards/ux-flow-format",
    "documentation-standards/component-contract-format",
    "process-standards/accessibility-checklist",
    "process-standards/design-system-conventions"
  ],
  scope: {
    files: [
      "docs/ux/**",
      "docs/requirements/**"   // annotation only
    ],
    tools: ["Read", "Write", "WebSearch", "Memory"],
    memoryNamespaces: {
      read:  ["ux", "requirements", "architecture", "conventions"],
      write: ["ux"]
    }
  }
};
```

#### Work Outputs

The UX Agent produces three document types, all under `/docs/ux/`:

**1. User Flow Documents** (`/docs/ux/flows/`) — Markdown, one per epic. Maps user journeys as numbered step sequences with decision branches, error paths, and entry/exit conditions. Specific enough that a developer can implement without guessing intent.

**2. Component Contracts** (`/docs/ux/components/`) — YAML or Markdown, one per new or significantly modified component. Defines required props/data, interaction states, accessibility requirements, and design system references. The Code Agent uses this as primary reference when implementing UI; the Test Agent derives interaction tests from it.

**3. Interaction Specifications** (`/docs/ux/interactions/`) — Markdown, for non-trivial interactions that need more detail than a component contract provides: multi-step forms, real-time update patterns, optimistic UI, error recovery flows spanning multiple components.

#### Routing Logic

Whether to spawn a UX Agent depends on the issue. The Planning Coordinator checks for UI/frontend indicators in the issue description or labels before deciding. Backend-only issues skip the UX Agent. Features with user-facing components require it. For new features with significant UI surface, UX runs before the Architect Agent so component contracts can inform the architecture. For smaller UI changes, they can run in parallel.

#### Delegation Chain Position

```
human
  → agent:pm-coordinator
    → agent:planning-coordinator
      → agent:ux-agent:epic-{id}        ← here
      → agent:requirements-agent:epic-{id}
      → agent:architect-agent:epic-{id}
```

#### Integration with the Reference Manifest Protocol

UX outputs slot directly into the reference manifest. A Code Agent manifest for a UI issue:

```json
{
  "task": "Implement login form",
  "brief": "OAuth2 login form with email/password. See UX flow for step sequence and component contract for state requirements.",
  "references": {
    "initiative": "tracker://PROJ-100",
    "epic": "tracker://PROJ-142",
    "issue": "tracker://PROJ-167",
    "ux_flow": "file:///docs/ux/flows/epic-142-auth-flow.md",
    "component_contract": "file:///docs/ux/components/login-form.yaml",
    "interaction_spec": "file:///docs/ux/interactions/oauth-redirect-flow.md",
    "architecture": "file:///docs/adr/003-auth-strategy.md",
    "design_system": "standards://design-system-conventions",
    "accessibility": "standards://accessibility-checklist",
    "coding_standards": "standards://coding-standards/typescript"
  }
}
```

### 3.5 Parallel vs. Sequential Execution

The hybrid model supports both:

**Sequential** (pipeline behavior):
```
Requirements → UX → Architecture → Implementation → Testing → Deployment
```

**Parallel** (within a phase):
```
Build Coordinator spawns:
  ├── Code Agent (implements feature A)
  ├── Code Agent (implements feature B)
  └── Test Agent (writes tests for feature A as it completes)
```

**Phased parallel** (dependent phases):
```
Phase 1 (parallel):
  ├── Database schema agent
  └── API contract agent
Phase 2 (after Phase 1, parallel):
  ├── Backend implementation agent
  └── Frontend implementation agent
Phase 3 (after Phase 2):
  └── Integration test agent
```

---

## 4. Standards-First Agent Definitions

### 4.1 Design Principle

Standards are not suggestions — they are part of each agent's identity. Every agent's system prompt includes the relevant standards for its role, injected at creation time. This ensures consistent output quality across all agents without relying on agents to "remember" to follow conventions.

### 4.2 Three-Tier Standards Model

```
System Defaults (shipped with the app)
  ├── coding-standards/
  │   ├── typescript.md
  │   ├── python.md
  │   └── rust.md
  ├── documentation-standards/
  │   ├── adr-format.md            (e.g., MADR template)
  │   ├── issue-format.md          (well-written issue template)
  │   ├── pr-format.md             (PR description template)
  │   ├── commit-conventions.md    (Conventional Commits)
  │   ├── ux-flow-format.md        (user flow document structure)
  │   └── component-contract-format.md  (component contract schema)
  ├── process-standards/
  │   ├── code-review.md
  │   ├── testing-requirements.md
  │   ├── security-checklist.md
  │   ├── accessibility-checklist.md    (WCAG 2.1 AA, component-level)
  │   └── design-system-conventions.md  (project template; overridden per project)
  └── etiquette/
      └── github-etiquette.md

Project Overrides (.sdlc/standards/)
  └── coding-standards/
      └── typescript.md            ← overrides the system default

Agent Definition (resolved at agent creation)
  agent: code-agent
  standards:
    - coding-standards/${language}  ← resolved at runtime
    - documentation-standards/pr-format
    - documentation-standards/commit-conventions
    - process-standards/testing-requirements
```

**Resolution order:** Agent-specific → Project overrides → System defaults. Standards files are referenced (not inlined) in the agent's system prompt via the reference manifest pattern.

### 4.3 Standards as Part of Agent Identity

Each agent definition includes a `standards` field that specifies which standard files apply:

```typescript
interface AgentDefinition {
  role: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model: "sonnet" | "opus";
  standards: string[];            // paths to standard files
  scope: AgentScope;              // see Section 7: Agent Identity
}
```

Standards are injected via the SessionStart hook — the agent receives references to the relevant standard files and loads them as needed. The agent doesn't choose which standards to follow; they are part of its configuration.

---

## 5. Reference-Based Handoff Protocol

### 5.1 The Problem with Summary-Based Handoffs

Most multi-agent systems transfer context between agents via summaries — either free-text summaries or structured JSON payloads containing compressed context. This creates a "telephone game" where information degrades with each hop. The summarizing agent decides what's "important," and it might be wrong.

Industry approaches include:
- **Google ADK**: Narrative casting and action attribution, building fresh working context from the sub-agent's perspective
- **Cognition AI**: Fine-tuned models specifically for summarization at agent boundaries
- **LangGraph**: Typed state objects passed between nodes
- **Best practice guidance**: Structured schemas and validators, treating handoffs like public APIs

All of these still transfer *data* — whether compressed, structured, or rewritten. None use a reference-based approach where the receiving agent gets a map to source materials and pulls what it needs.

### 5.2 The Reference Manifest Pattern

Instead of passing summaries, coordinators pass a **reference manifest** — a structured document containing URI pointers to living artifacts:

```json
{
  "task": "Implement user authentication",
  "brief": "OAuth2 flow with JWT tokens, see ADR-003 for architectural rationale",
  "references": {
    "initiative": "tracker://PROJ-100",
    "epic": "tracker://PROJ-142",
    "issue": "tracker://PROJ-167",
    "architecture": "file:///docs/adr/003-auth-strategy.md",
    "api_contract": "file:///docs/api/auth-endpoints.yaml",
    "coding_standards": "standards://coding-standards/typescript",
    "related_decisions": [
      "file:///docs/adr/001-session-management.md",
      "file:///docs/adr/005-token-rotation.md"
    ],
    "prior_work": "memory://query/auth+implementation+decisions",
    "audit_trail": "audit://project/PROJ-167"
  }
}
```

The `brief` field provides 2-3 sentences of orientation so the agent has context before it starts pulling references. The substance comes from the references themselves.

### 5.3 Agent-Driven Selective Loading

The receiving agent decides what to pull based on the task:

1. Agent receives the reference manifest as its task assignment
2. Agent reads the `brief` for orientation
3. Agent loads the issue details from the tracker (`tracker://PROJ-167`)
4. Agent loads the primary ADR (`file:///docs/adr/003-auth-strategy.md`)
5. Agent loads coding standards for the relevant language
6. If it encounters a question about session management during implementation, it pulls `adr/001-session-management.md` on demand
7. If it needs to understand what was tried before, it queries `memory://query/auth+implementation+decisions`

This inverts the default assumption in the field. Instead of asking "how do we compress context for the next agent?", the question becomes "how do we give the next agent a map so it can find what it needs?"

### 5.4 Reference Resolver

Agents need a **reference resolver** MCP tool that can dereference the URI schemes used in manifests:

```typescript
const referenceResolver = createSdkMcpServer({
  name: "reference-resolver",
  tools: [
    tool("resolve_ref", "Load content from a reference URI", {
      uri: z.string().describe("Reference URI to resolve")
    }, async (args) => {
      const { uri } = args;

      if (uri.startsWith("tracker://")) {
        // Fetch issue/epic/initiative from issue tracker
        return await fetchFromTracker(uri);
      }
      if (uri.startsWith("file://")) {
        // Read file from project directory
        return await readProjectFile(uri);
      }
      if (uri.startsWith("standards://")) {
        // Resolve standards with override chain
        return await resolveStandard(uri);
      }
      if (uri.startsWith("memory://")) {
        // Query memory store
        return await queryMemory(uri);
      }
      if (uri.startsWith("audit://")) {
        // Query audit trail
        return await queryAudit(uri);
      }
    })
  ]
});
```

### 5.5 Documentation Traceability Chain

Every documentation artifact produced by agents includes a `## References` section with required fields linking back to the work hierarchy:

```markdown
## References
- Initiative: PROJ-100
- Epic: PROJ-142
- Issue: PROJ-167
- Related ADRs: [003-auth-strategy](../adr/003-auth-strategy.md)
- Related PRs: #245, #248
```

This is enforced by the Documentation Specialist, which reviews artifacts and flags any missing traceability links. The traceability chain creates a **provenance graph** — every artifact carries issue IDs that let you reconstruct the full decision chain behind any change.

Even without a hierarchical issue tracker, these embedded references create a queryable chain. A simple grep across the docs directory surfaces everything related to an initiative. A future model could build a graph from these references automatically.

### 5.6 Why This Pattern Matters

The reference-based approach solves three problems simultaneously that the industry is currently fighting individually:

1. **Eliminates summarization quality problems** — no lossy compression, agents read source material directly
2. **Solves context window pressure** — agents only load what they need for the current task
3. **Creates an inherent audit trail** — you can see exactly what references an agent consulted

The tradeoff is that it requires a well-organized project structure — ADRs, specs, and issues need to actually exist and be well-written. This is why the standards-first approach (Section 4) and the Documentation Specialist agent are prerequisites, not nice-to-haves.

---

## 6. Memory Architecture: Local-First

### 6.1 The Core Problem

The "disconnected models problem" — identified in 2025 research as one of the biggest barriers to effective multi-agent systems — is that LLM agents lose context between sessions, between agents, and as context windows fill up. Your SDLC agents need to:

- Share project knowledge (requirements, architecture decisions, code conventions)
- Remember what was tried and what failed
- Maintain coherent state across potentially dozens of agent invocations
- Persist across application restarts

### 6.2 Memory Layer (Revised Role)

With the reference-based handoff model, the memory layer's role shifts from "knowledge store" to **index, reference resolver, and learning repository**:

**What memory stores:**
- Agent learnings: patterns that worked, mistakes to avoid, corrections made
- Project metadata: configuration, agent assignments, session state
- Semantic index: searchable entries that complement the reference system
- Cross-cutting knowledge: information that doesn't belong to a specific file or issue

**What memory does NOT store (lives elsewhere):**
- Architecture decisions → ADR files on disk
- Requirements and specs → Document files on disk
- Work status → Issue tracker
- Code → Source control
- Agent actions → Audit trail (separate store)

### 6.3 Implementation: SQLite + FTS5

SQLite is the ideal local-first storage:

- **Zero infrastructure**: Single file per project, no server process
- **Portable**: Copy the `.db` file to move the entire project state
- **Performant**: Handles the scale of a single-user SDLC tool easily
- **Tauri-native**: `tauri-plugin-sql` provides built-in SQLite support

**Schema:**

```sql
-- Project state
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT,
  description TEXT,
  created_at TIMESTAMP,
  config JSON
);

-- Agent sessions and state
CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  agent_id TEXT,           -- full agent identity ID
  agent_type TEXT,         -- 'pm_coordinator', 'code_agent', etc.
  session_id TEXT,         -- Claude SDK session ID for resume
  status TEXT,             -- 'active', 'paused', 'completed'
  created_at TIMESTAMP,
  updated_at TIMESTAMP
);

-- Memory entries (learnings, cross-cutting knowledge)
CREATE TABLE memory_entries (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  category TEXT,           -- 'learning', 'convention', 'context', 'index'
  content TEXT,
  metadata JSON,
  created_by TEXT,         -- agent identity ID
  created_at TIMESTAMP,
  weight REAL DEFAULT 1.0  -- relevance weight, decays over time
);

-- Full-text search index
CREATE VIRTUAL TABLE memory_fts USING fts5(
  content,
  category,
  content='memory_entries',
  content_rowid='rowid'
);
```

### 6.4 Memory Access via MCP Tools

```typescript
const memoryServer = createSdkMcpServer({
  name: "project-memory",
  tools: [
    tool("memory_read", "Search project memory for relevant context", {
      query: z.string(),
      category: z.string().optional(),
      limit: z.number().default(10)
    }, async (args) => {
      // FTS5 keyword search (day one)
      // Add vector search later when project scale warrants it
      const results = await keywordSearch(args.query, args.category, args.limit);
      return { content: [{ type: "text", text: JSON.stringify(results) }] };
    }),

    tool("memory_write", "Store knowledge for other agents", {
      category: z.string(),
      content: z.string(),
      metadata: z.record(z.unknown()).optional()
    }, async (args) => {
      await storeMemoryEntry(args);
      return { content: [{ type: "text", text: "Stored successfully" }] };
    }),

    tool("memory_context", "Get project context summary", {
      project_id: z.string()
    }, async (args) => {
      const context = await buildProjectContext(args.project_id);
      return { content: [{ type: "text", text: context }] };
    })
  ]
});
```

### 6.5 Context Injection Strategy

Rather than dumping all memory into every agent's prompt, use a tiered approach:

1. **System prompt**: Agent role + standards references (always present)
2. **Session start hook**: Inject the reference manifest for the current task
3. **On-demand**: Agent calls `memory_read` or `resolve_ref` when it needs additional context
4. **Handoff manifests**: Coordinators pass reference manifests, not raw memory or summaries

### 6.6 Semantic Search as an Additive Layer

Vector embeddings (e.g., `all-MiniLM-L6-v2`, a sentence embedding model that converts text to 384-dimensional vectors for similarity search) are **deferred to a later phase**. Start with FTS5 keyword search and explicit references.

**When to add semantic search:**
- The project accumulates 50+ ADRs, hundreds of issues, multiple sprints of learnings
- Keyword search isn't finding relevant connections (terminology varies across documents)
- Agents asking "what past decisions are relevant to X?" would benefit from meaning-based search over exact keyword matching

**When you add it, the implementation is clean:**

```sql
-- Add to existing schema
CREATE VIRTUAL TABLE memory_vectors USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[384]
);
```

```typescript
// Add to MemoryStore interface
interface MemoryStore {
  // Existing
  keywordSearch(query: string, limit: number): Promise<MemoryEntry[]>;
  // New
  semanticSearch(query: string, limit: number): Promise<MemoryEntry[]>;
  hybridSearch(query: string, limit: number): Promise<MemoryEntry[]>;  // RRF fusion
}
```

The reference-based handoff system doesn't change at all. Semantic search is a better index, not a different architecture.

### 6.7 Abstraction for Future Portability

The memory layer is accessed through an interface:

```typescript
interface MemoryStore {
  read(query: string, options?: ReadOptions): Promise<MemoryEntry[]>;
  write(entry: MemoryEntry): Promise<void>;
  update(id: string, updates: Partial<MemoryEntry>): Promise<void>;
  delete(id: string): Promise<void>;

  keywordSearch(query: string, limit: number): Promise<MemoryEntry[]>;
  // semanticSearch and hybridSearch added when needed

  getProjectContext(projectId: string): Promise<ProjectContext>;

  initialize(config: StoreConfig): Promise<void>;
  close(): Promise<void>;
}
```

**Local implementation**: `SqliteMemoryStore` — SQLite + FTS5, single `.db` file per project.

**Future cloud implementation**: `CloudMemoryStore` — Turso (SQLite-compatible cloud), Postgres + pgvector, etc. Same interface.

---

## 7. Agent Identity Model

### 7.1 Design Rationale

Agent identity solves two problems: **preventing accidental cross-boundary work** (a code agent modifying the wrong module) and **enabling auditability** (tracing any action back through a delegation chain to the human who initiated the work).

The identity model is designed now, with a credential field structured for future FIDO-like cryptographic extension.

### 7.2 Identity Schema

```typescript
interface AgentIdentity {
  // Unique, immutable identity
  id: string;                     // "agent:code:auth-module:sprint-42"
  type: AgentType;                // "coordinator" | "specialist" | "reviewer"
  role: string;                   // "code-agent", "test-agent", etc.

  // Delegation chain (who spawned this agent and why)
  delegatedBy: string;            // parent agent or user ID
  delegationChain: string[];      // full chain back to human
  purpose: string;                // "Implement PROJ-167: user auth"

  // Scope restrictions
  scope: {
    issues: string[];             // tracker IDs this agent can touch
    files: string[];              // glob patterns for file access
    branches: string[];           // git branches allowed
    tools: string[];              // allowed tool names
    memoryNamespaces: {
      read: string[];             // memory categories readable
      write: string[];            // memory categories writable
    };
  };

  // Standards (resolved from three-tier model)
  standards: string[];            // paths to applicable standard files

  // Temporal bounds
  createdAt: string;
  expiresAt: string;              // agents don't live forever

  // For future FIDO/cryptographic extension
  credential?: {
    type: "local" | "fido2" | "mtls";
    publicKey?: string;
    attestation?: object;
  };
}
```

### 7.3 Delegation Chain

Every agent knows who created it and why, all the way back to the human user:

```
human:kevin
  → agent:pm-coordinator:proj-100
    → agent:build-coordinator:proj-100:epic-142
      → agent:code:auth-module:sprint-42
```

The chain is immutable — an agent cannot modify its own delegation chain. This means:
- Any action can be traced back through the full chain to the human
- If an agent tries something outside its scope, the coordination error is identifiable
- The delegation chain becomes a certificate chain when cryptographic identity is added

### 7.4 Scope Enforcement via PreToolUse Hooks

```typescript
const enforceScope: Hook = {
  matcher: "*",  // all tools
  handler: async (toolCall, agentIdentity) => {
    // File scope check
    if (["Write", "Edit"].includes(toolCall.tool)) {
      const targetPath = toolCall.params.file_path;
      if (!matchesGlob(targetPath, agentIdentity.scope.files)) {
        await auditStore.log({
          eventType: "scope.violation",
          agentId: agentIdentity.id,
          delegationChain: agentIdentity.delegationChain,
          action: `Attempted write to ${targetPath}`,
          result: "blocked",
          reason: `File not in agent scope: ${agentIdentity.scope.files}`
        });
        return { action: "block" };
      }
    }

    // Tool allowlist check
    if (!agentIdentity.scope.tools.includes(toolCall.tool)) {
      await auditStore.log({
        eventType: "tool.blocked",
        agentId: agentIdentity.id,
        delegationChain: agentIdentity.delegationChain,
        action: `Attempted use of ${toolCall.tool}`,
        result: "blocked",
        reason: "Tool not in agent scope"
      });
      return { action: "block" };
    }

    // Temporal check
    if (new Date() > new Date(agentIdentity.expiresAt)) {
      await auditStore.log({
        eventType: "credential.expired",
        agentId: agentIdentity.id,
        delegationChain: agentIdentity.delegationChain,
        action: toolCall.tool,
        result: "blocked",
        reason: "Agent credential expired"
      });
      return { action: "block" };
    }

    return { action: "allow" };
  }
};
```

### 7.5 FIDO Extension Path

The `credential` field is intentionally minimal now. When ready for cryptographic identity:

1. Agent gets a keypair at creation time
2. Actions are signed with the agent's private key
3. The audit log becomes cryptographically verifiable
4. The delegation chain becomes a certificate chain
5. External services can verify agent identity via public key / attestation

The architecture doesn't need to change — you're strengthening the identity assertions without modifying the model.

### 7.6 Future Authorization Enhancements

The scope model supports dynamic, context-aware conditions:

- **Temporal**: "Only allow Write during business hours"
- **Approval-gated**: "Require human approval for files matching `**/config/**`"
- **Behavioral**: "Flag if an agent hits 3+ scope violations in a session"
- **Risk-based**: "Escalate to coordinator if modifying files outside primary scope"

These can be added as additional PreToolUse hook conditions without changing the identity schema.

---

## 8. Audit Trail

### 8.1 Design Principle

The audit trail is **append-only, abstracted, and queryable**. It captures three categories of events:

1. **Agent lifecycle** — who was created, by whom, with what scope, when did they start/stop
2. **Actions** — every tool call, file operation, issue update, memory access
3. **Decisions** — routing choices, approval outcomes, handoff initiations — the inflection points that explain *why* things happened

### 8.2 Event Schema

```typescript
type AuditEventType =
  // Lifecycle
  | "agent.created" | "agent.completed" | "agent.failed" | "agent.expired"
  // Actions
  | "tool.invoked" | "tool.completed" | "tool.blocked"
  | "file.read" | "file.write" | "file.delete"
  | "issue.created" | "issue.updated" | "issue.closed"
  | "memory.read" | "memory.write"
  // Decisions
  | "decision.routing" | "decision.approval" | "decision.rejection"
  | "handoff.initiated" | "handoff.completed"
  // Security
  | "scope.violation" | "credential.expired" | "auth.failed";

interface AuditEvent {
  id: string;
  timestamp: string;               // ISO 8601
  projectId: string;

  // Who
  agentId: string;
  agentRole: string;
  delegationChain: string[];       // full chain to human

  // What
  eventType: AuditEventType;
  action: string;                  // human-readable description
  details: Record<string, any>;    // tool params, file paths, etc.

  // Why (traceability)
  issueRef?: string;               // PROJ-167
  initiativeRef?: string;          // PROJ-100
  sessionId: string;

  // Outcome
  result: "success" | "failure" | "blocked" | "pending";
  reason?: string;                 // especially for blocks/failures
}
```

### 8.3 Audit Store Abstraction

```typescript
interface AuditStore {
  log(event: AuditEvent): Promise<void>;

  // Query patterns
  getByAgent(agentId: string, opts?: TimeRange): Promise<AuditEvent[]>;
  getByIssue(issueRef: string): Promise<AuditEvent[]>;
  getByProject(projectId: string, opts?: TimeRange & {
    eventTypes?: AuditEventType[]
  }): Promise<AuditEvent[]>;
  getBySession(sessionId: string): Promise<AuditEvent[]>;
  getDelegationTrace(agentId: string): Promise<AuditEvent[]>;
  getScopeViolations(projectId: string, opts?: TimeRange): Promise<AuditEvent[]>;

  // Lifecycle
  initialize(): Promise<void>;
  close(): Promise<void>;
}
```

### 8.4 Backend Implementations

**FileSystemAuditStore** (recommended starting point):
- Writes JSONL files: `/project/.sdlc/audit/2026-02-22.jsonl`
- Human-readable, greppable, works with standard Unix tools (`cat`, `jq`, `grep`)
- One file per day or per session
- Best for early development and debugging

**SqliteAuditStore** (graduate to when query performance matters):
- Separate `.audit.db` file per project
- Indexed on `agentId`, `issueRef`, `eventType`, `timestamp`
- Separate from the memory database — different access patterns (memory is read-heavy with search; audit is append-heavy with occasional queries)
- Independent retention management — prune memory aggressively, keep audit logs indefinitely

**Future cloud backends:**
- Ship logs to a SIEM
- Push to CloudWatch or equivalent
- Write to an append-only ledger (for cryptographic verification with FIDO identity)

### 8.5 How the Audit Trail Integrates

The audit store is populated from two automatic sources:

1. **PostToolUse hook** — logs every agent action automatically. Agents don't choose whether to log; it's a side effect of the existing hook system.
2. **Scope enforcement hook** (PreToolUse) — logs scope violations and blocked actions (see Section 7.4).

The audit trail is also a **queryable resource for agents**:
- The Documentation Specialist queries audit events to auto-generate changelogs ("what happened in Sprint 42?")
- Coordinators check for scope violation patterns as a signal to re-scope agents
- The reference manifest can include `audit://project/PROJ-167` as a pointer to everything done on an issue
- Post-mortem analysis: reconstruct the full chain of agent decisions and actions for any work item

---

## 9. Issue Tracking and Source Control Integration

### 9.1 Issue Tracker MCP Server

The issue tracker is a first-class integration, not an afterthought. A dedicated MCP server provides tools for:

```typescript
const trackerServer = createSdkMcpServer({
  name: "issue-tracker",
  tools: [
    // Work hierarchy management
    tool("tracker_create_initiative", ...),
    tool("tracker_create_epic", ...),
    tool("tracker_create_issue", ...),

    // Status management
    tool("tracker_update_status", ...),
    tool("tracker_assign", ...),
    tool("tracker_link", ...),        // link issues to PRs, ADRs

    // Query
    tool("tracker_get_issue", ...),
    tool("tracker_list_issues", ...),
    tool("tracker_get_hierarchy", ...),  // get full initiative → epic → issue tree
  ]
});
```

The MCP server abstracts the specific tracker (GitHub Projects, Jira, Linear) behind a consistent interface. Swapping trackers requires only a new MCP server implementation.

### 9.2 Source Control Integration

Agents interact with source control through existing SDK tools (Bash for git commands) plus conventions enforced by standards:

- **Branch naming**: `{issue-id}/{short-description}` (e.g., `PROJ-167/token-refresh-endpoint`)
- **Commit messages**: Conventional Commits with issue references
- **PR descriptions**: Templated format with References section (linking initiative, epic, issue, ADRs)

The Documentation Specialist validates that PRs follow these conventions before they're marked ready for review.

---

## 10. Implementation Roadmap

### Phase 1: Foundation (Weeks 1–3)
- Set up Tauri 2.0 project with Svelte + TypeScript frontend
- Implement SQLite memory layer with FTS5 in Rust backend
- Implement FileSystem audit store (JSONL)
- Create the memory MCP server (read/write/search tools)
- Create the reference resolver MCP tool
- Build a single agent integration: one Code Agent with identity, scoping, and audit
- Basic UI: project creation, agent status, memory inspector
- Ship system default standards files

### Phase 2: Agent System (Weeks 4–6)
- Define system prompts and identity templates for all SDLC agents
- Implement the coordinator pattern: PM Coordinator → Phase Coordinators → Specialists
- Implement reference manifest handoff protocol
- Add scope enforcement hooks (PreToolUse) and audit logging hooks (PostToolUse)
- Implement session persistence and resume
- Build the agent dashboard UI with streaming output
- Implement Documentation Specialist agent

### Phase 3: Workflow Engine & Integrations (Weeks 7–9)
- Implement workflow definitions (sequential, parallel, phased)
- Add dependency tracking between agents/tasks
- Build approval workflows (human-in-the-loop for critical decisions)
- Issue tracker MCP server (GitHub Projects first, then abstract)
- Source control conventions and enforcement
- Implement three-tier standards resolution (system → project → agent)
- Context injection optimization (relevant references at session start)

### Phase 4: Hardening & Extension (Weeks 10–12)
- Upgrade audit store to SQLite if query performance warrants it
- Add semantic search layer (sqlite-vec + all-MiniLM-L6-v2) if project scale warrants it
- Implement memory weight decay and garbage collection
- Build project templates for common SDLC patterns
- Add documentation traceability validation (automated checks for missing references)
- Performance optimization and testing
- Abstract memory and audit interfaces for future cloud portability

### Phase 5: Security & Advanced Identity (Future)
- FIDO-like cryptographic agent identity
- Signed audit logs (cryptographic verification)
- Dynamic authorization policies (temporal, risk-based)
- Certificate chain delegation verification
- External service authentication via agent credentials

---

## 11. Key Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| **Rust learning curve** | Slows Tauri backend development | Keep Rust surface minimal; use existing plugins; lean on Claude Code |
| **Agent context overflow** | Agents lose coherence on large projects | Reference-based handoffs (agents load only what they need); subagent isolation |
| **Reference quality dependency** | Bad docs → bad agent performance | Documentation Specialist validates quality; standards enforced at agent level |
| **Memory staleness** | Outdated context misleads agents | Weight decay; timestamp-aware retrieval; explicit invalidation |
| **API costs** | Multiple agents = many API calls | Sonnet for specialists, Opus for coordinators; aggressive caching |
| **Coordination failures** | Agents produce conflicting work | Scoped identity; resource locking; human approval gates |
| **WebView inconsistency** | Tauri renders differently across OS | Test on all platforms; Tailwind for consistency |
| **Tracker integration complexity** | Different trackers have different APIs | MCP abstraction; start with one (GitHub), extend |
| **Scope over-restriction** | Agents blocked from legitimate work | Start permissive, tighten based on audit trail patterns |

---

## 12. Alternatives Considered

### 12.1 Electron
Rejected as primary choice due to resource overhead (150–300 MB idle memory) that would compound with multiple agent processes. Remains a viable fallback — the agent layer is pure TypeScript either way.

### 12.2 Python SDK Instead of TypeScript
The Python SDK lacks SessionStart/SessionEnd hooks and would require bridging between Python processes and the Tauri/TypeScript frontend. TypeScript keeps the entire agent + frontend stack unified.

### 12.3 Dedicated Vector Database (Chroma, Qdrant)
Adds infrastructure complexity (separate server process). SQLite with FTS5 handles day-one needs. Vector extensions (sqlite-vec) can be added later when project scale justifies semantic search. The abstracted interface allows swapping without agent changes.

### 12.4 LangChain / LangGraph Orchestration
These are general-purpose orchestration frameworks, but the Claude Agent SDK already provides the agent loop, tool system, subagent support, and context management. Adding LangChain would be an unnecessary abstraction layer duplicating SDK capabilities.

### 12.5 Summary-Based Handoffs
The prevailing industry approach. Rejected in favor of reference-based manifests because summaries introduce lossy compression, the summarizing agent decides what's relevant (potential for information loss), and summaries don't create an audit trail of what context was actually consulted.

### 12.6 React Frontend
React was the initial recommendation (v2–v3) due to its large ecosystem and broad developer familiarity. Replaced with Svelte in v4 for this project's specific context: the frontend is a secondary layer — the core innovation lives in the agent coordination architecture. Svelte's fine-grained reactivity handles streaming output from multiple concurrent agents more naturally than React's virtual DOM approach, which requires explicit memoization (`useMemo`, `useCallback`, `React.memo`) to avoid unnecessary re-renders. Svelte's built-in stores provide shared state management without additional dependencies (React typically requires Zustand, Jotai, or Redux). The lower boilerplate means less wiring code for the same functionality. React's primary advantages — massive component library ecosystem and large hiring pool — are less relevant for a personal project where Claude Code writes most of the frontend code. Tauri has first-class Svelte templates. The decision is reversible: the frontend sits behind Tauri's IPC boundary and the Rust backend and TypeScript agent layers are completely unaffected by the framework choice.

---

## 13. Summary of Recommendations

| Decision | Recommendation | Rationale |
|---|---|---|
| **SDK** | Claude Agent SDK (TypeScript) | Full agent harness, subagents, hooks, MCP, sessions |
| **Desktop framework** | Tauri 2.0 | Lightweight, Rust backend for storage, security-first |
| **Frontend** | Svelte + TypeScript | Fine-grained reactivity, low boilerplate, built-in stores; frontend is secondary to agent layer |
| **Agent pattern** | Hybrid coordinator with work hierarchy | Initiative → Epic → Issue maps to agent hierarchy |
| **Handoff protocol** | Reference manifests with URI pointers | Novel pattern; eliminates summarization loss; agent-driven loading |
| **Standards** | Three-tier model (system → project → agent) | Baked into agent identity, not optional |
| **Memory** | SQLite + FTS5 (local-first) | Zero-ops, portable; semantic search added later |
| **Audit trail** | Abstracted store (JSONL → SQLite → cloud) | Append-only; captures lifecycle, actions, decisions |
| **Agent identity** | Scoped credentials with delegation chains | Designed for FIDO extension; enforced via hooks |
| **Issue tracking** | MCP-abstracted (GitHub first) | Source of truth for work structure |
| **Embeddings** | Deferred (add when project scale warrants) | FTS5 + explicit references sufficient for day one |
| **Model strategy** | Sonnet for specialists, Opus for coordinators | Balance cost vs. reasoning quality |
| **Documentation** | Specialist agent + enforced standards | Prerequisite for reference-based handoffs |

---

*Research compiled from Claude Agent SDK documentation, Anthropic engineering blog, academic research on multi-agent memory systems and context engineering (2025–2026), desktop framework benchmarks, Google ADK architecture documentation, Microsoft multi-agent reference architecture, agent identity management research (arXiv 2510.25819), and community implementations.*
