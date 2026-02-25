# PROJECT KNOWLEDGE BASE

**Updated:** 2026-02-24
**Stack:** Vercel AI SDK (`ai`) + Vercel Chat SDK (`chat`) + BullMQ + Docker + Bun

---

## VISION

AxeAI is a multi-platform AI bot that listens on **Discord** (primary) and **Slack** (later) for natural-language requests, then autonomously generates integration tests and creates PRs on GitHub. It uses a **hierarchical agent architecture** built on top of the Vercel AI SDK's `ToolLoopAgent` and the Vercel Chat SDK for unified multi-platform messaging.

### Why This Evolution?

| Before (v1) | After (v2) |
|---|---|
| GitHub-only via Probot webhooks | Discord + Slack + GitHub via Chat SDK adapters |
| Single flat agent (`ralph-loop-agent`) | Hierarchical `ToolLoopAgent` tree with subagents |
| No memory across sessions | Persistent memory via AI SDK memory providers |
| Probot event handler doing everything | Chat SDK event-driven architecture with BullMQ decoupling |

---

## ARCHITECTURE

```
Discord / Slack / GitHub (Chat SDK Adapters)
           |
     Chat SDK Core  (event handlers: onNewMention, onMessage, onSlashCommand)
           |
     BullMQ Producer  (enqueue jobs to Redis)
           |
     BullMQ Worker    (dequeue + orchestrate)
           |
  Orchestrator Agent  (ToolLoopAgent - "the brain")
       /       \
      /         \
 Planner       Coder           <-- Subagents (ToolLoopAgent)
 Subagent      Subagent
    |             |
 analyzes PR   writes tests
 + plans       + runs in Docker sandbox
    |             |
     \           /
      \         /
   Reviewer Subagent            <-- Validates output quality
           |
   GitHub PR (via Octokit / gh CLI)
```

### Hierarchical Agent Breakdown

| Agent | Role | Tools | Model Strategy |
|---|---|---|---|
| **Orchestrator** | Receives user request, delegates to subagents, synthesizes final output | `planTask`, `generateTests`, `reviewOutput`, `memory` | High-capability model (e.g. `claude-sonnet-4-5`) |
| **Planner** | Analyzes the repo/PR, understands codebase structure, produces a test plan | `readFile`, `searchCode`, `listFiles`, `gitDiff` | Fast model for exploration (e.g. `gpt-4.1-mini`) |
| **Coder** | Writes test files, runs them in Docker sandbox, iterates until passing | `writeFile`, `runInSandbox`, `installDeps`, `runTests` | High-capability model for code gen |
| **Reviewer** | Reviews generated tests for quality, coverage, correctness | `readFile`, `analyzeTestCoverage` | High-capability model |

Each subagent runs in an **isolated context window** (AI SDK subagent pattern). The orchestrator only receives summarized output via `toModelOutput`, keeping its context clean.

---

## STRUCTURE

```
.
├── src/
│   ├── server.ts              # Chat SDK bot setup + adapter registration
│   ├── index.ts               # Bot event handlers (onNewMention, etc.) -> BullMQ Producer
│   ├── worker.ts              # BullMQ Consumer -> Spawns Orchestrator Agent
│   ├── agents/
│   │   ├── orchestrator.ts    # Top-level ToolLoopAgent (delegates to subagents)
│   │   ├── planner.ts         # Planner subagent (repo analysis + test planning)
│   │   ├── coder.ts           # Coder subagent (test generation + sandbox execution)
│   │   └── reviewer.ts        # Reviewer subagent (quality gate)
│   ├── tools/
│   │   ├── github.ts          # GitHub tools (clone, diff, create PR, push)
│   │   ├── sandbox.ts         # Docker sandbox tools (exec, writeFile, runTests)
│   │   ├── filesystem.ts      # Read/search/list tools for repo exploration
│   │   └── memory.ts          # Persistent memory tool (custom or provider-backed)
│   ├── adapters/
│   │   ├── discord.ts         # Discord adapter config (Chat SDK)
│   │   ├── slack.ts           # Slack adapter config (Chat SDK) [Phase 2]
│   │   └── github.ts          # GitHub adapter config (Chat SDK) [replaces Probot]
│   ├── sandbox.ts             # Dockerode abstraction (Container Mgmt) [existing]
│   └── agent.ts               # [DEPRECATED - migrate to agents/orchestrator.ts]
├── package.json
├── tsconfig.json
└── AGENTS.md
```

---

## WHERE TO LOOK

| Task | Location | Notes |
|---|---|---|
| **Bot Setup & Adapters** | `src/server.ts` | Chat SDK initialization, adapter registration |
| **Event Handling** | `src/index.ts` | `onNewMention`, `onMessage` -> enqueue to BullMQ |
| **Job Processing** | `src/worker.ts` | Dequeues jobs, invokes orchestrator agent |
| **Orchestrator Agent** | `src/agents/orchestrator.ts` | Top-level `ToolLoopAgent`, delegates via subagent tools |
| **Planner Subagent** | `src/agents/planner.ts` | Repo analysis, test plan generation |
| **Coder Subagent** | `src/agents/coder.ts` | Test writing + Docker sandbox execution |
| **Reviewer Subagent** | `src/agents/reviewer.ts` | Quality validation before PR creation |
| **GitHub Tools** | `src/tools/github.ts` | Clone, diff, branch, commit, push, create PR |
| **Sandbox Tools** | `src/tools/sandbox.ts` | Docker container exec, file ops |
| **Memory** | `src/tools/memory.ts` | Persistent memory across sessions |
| **Docker Abstraction** | `src/sandbox.ts` | Low-level Dockerode wrapper |

---

## KEY DEPENDENCIES

| Package | Purpose |
|---|---|
| `ai` | Vercel AI SDK - `ToolLoopAgent`, `tool()`, `stepCountIs`, subagent patterns |
| `chat` | Vercel Chat SDK - unified bot framework for Discord/Slack/GitHub |
| `@chat-adapter/discord` | Discord platform adapter |
| `@chat-adapter/slack` | Slack platform adapter (Phase 2) |
| `@chat-adapter/github` | GitHub platform adapter (replaces Probot) |
| `@chat-adapter/state-redis` | Redis-backed distributed state for Chat SDK |
| `@ai-sdk/openai` | OpenAI/gateway provider |
| `@ai-sdk/anthropic` | Anthropic provider (for Claude models) |
| `bullmq` / `ioredis` | Job queue + Redis |
| `dockerode` | Docker container management |
| `zod` | Schema validation (tool inputSchemas) |

---

## CONVENTIONS

### Architecture Rules
- **Chat SDK is the entry point.** All platform events (Discord, Slack, GitHub) flow through Chat SDK adapters. No direct platform API calls for receiving events.
- **Queues decouple events from execution.** Event handlers in `src/index.ts` MUST only enqueue BullMQ jobs. Never run agent logic in event handlers.
- **Hierarchical agents.** The orchestrator delegates to subagents via tools. Subagents return summaries via `toModelOutput`. Never let a single agent do everything.
- **Sandboxing is mandatory.** All file operations and test execution MUST go through `DockerSandbox`. Host execution is FORBIDDEN.
- **Git operations run inside containers.** Clone/Commit/Push happens INSIDE the Docker container via `sandbox.exec()`.

### AI SDK Patterns
- **Always use `ToolLoopAgent`** for agent definitions. Never use raw `generateText` loops.
- **Subagent tools use `toModelOutput`** to control what the parent sees. Subagents do heavy exploration; parents get summaries.
- **Memory is explicit.** Use the memory tool for cross-session context. Don't rely on conversation history alone.
- **Configure `stopWhen: stepCountIs(N)`** for all agents. Orchestrator: 30 steps. Subagents: 20 steps.
- **Use `callOptionsSchema`** for dynamic runtime config (repo URL, PR number, user context).
- **Pass `abortSignal`** through all subagent invocations for proper cancellation.

### Chat SDK Patterns
- **Use `thread.post(result.textStream)`** for streaming AI responses to Discord/Slack.
- **Use `thread.subscribe()`** in `onNewMention` to listen for follow-up messages in a thread.
- **State management** uses `@chat-adapter/state-redis` for distributed state across workers.

---

## ANTI-PATTERNS

- **Direct FS Access**: Never use `fs.writeFile` on host for user code.
- **Synchronous AI in event handlers**: Never await AI calls in `src/index.ts`. Push to queue.
- **Flat agent architecture**: Never put all logic in one agent. Use the hierarchical subagent pattern.
- **Unbounded agent loops**: Always set `stopWhen`. Never let agents run indefinitely.
- **Hardcoded model IDs**: Use the AI Gateway provider or config. Never hardcode model strings.
- **Skipping `toModelOutput`**: Subagent results MUST be summarized before returning to parent. Raw tool call history must not leak up.
- **Platform-specific code in core logic**: Agent logic must be platform-agnostic. Platform specifics stay in adapter configs.

---

## IMPLEMENTATION PHASES

### Phase 1: Discord Bot + Hierarchical Agents (Current Priority)
1. Install Chat SDK (`chat`, `@chat-adapter/discord`, `@chat-adapter/state-redis`)
2. Set up `src/server.ts` with Chat SDK + Discord adapter
3. Migrate event handling from Probot to Chat SDK `onNewMention` / `onMessage`
4. Build `src/agents/orchestrator.ts` using `ToolLoopAgent` with subagent tools
5. Build `src/agents/planner.ts` - repo analysis subagent
6. Build `src/agents/coder.ts` - test generation subagent with sandbox tools
7. Build `src/agents/reviewer.ts` - quality gate subagent
8. Refactor `src/tools/` - extract GitHub, sandbox, filesystem, memory tools
9. Wire BullMQ worker to invoke orchestrator agent
10. Add memory tool for persistent context across sessions

### Phase 2: Slack + GitHub Adapters
1. Add `@chat-adapter/slack` adapter to `src/server.ts`
2. Add `@chat-adapter/github` adapter (replace Probot entirely)
3. Ensure all event handlers work across platforms via Chat SDK abstraction
4. Remove Probot dependency

### Phase 3: Advanced Features
1. Streaming subagent progress to Discord/Slack via preliminary tool results
2. RAG-powered coder agent (embed repo for semantic code search)
3. Parallel subagent execution (multiple planner/coder agents for large PRs)
4. User preference memory (coding style, test framework preferences)
5. Interactive approval flows via Chat SDK JSX cards + buttons

---

## COMMANDS

```bash
# Dev - Bot server (Requires Redis + Docker + Discord token)
bun run dev

# Dev - Worker (separate terminal)
bun run dev:worker

# Start (Production)
bun run start

# Worker (Production)
bun run worker
```

---

## ENVIRONMENT VARIABLES

```
# Discord
DISCORD_BOT_TOKEN=
DISCORD_APPLICATION_ID=

# Slack (Phase 2)
SLACK_BOT_TOKEN=
SLACK_SIGNING_SECRET=

# GitHub App
GITHUB_APP_ID=
GITHUB_PRIVATE_KEY=
GITHUB_WEBHOOK_SECRET=

# AI Providers
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

# Infrastructure
REDIS_HOST=
REDIS_PORT=
DOCKER_HOST=        # or socket
```

---

## AGENT SKILLS

Two installed skills provide authoritative documentation for the core SDKs. **Always consult these before writing code** - do not rely on training data.

| Skill | Location | Use For |
|---|---|---|
| **AI SDK** | `.agents/skills/ai-sdk/` | `ToolLoopAgent`, `tool()`, `stepCountIs`, subagents, `toModelOutput`, `callOptionsSchema`, memory, streaming, structured output, provider setup |
| **Chat SDK** | `.agents/skills/chat-sdk/` | `Chat` class, adapters (`@chat-adapter/*`), event handlers (`onNewMention`, `onSubscribedMessage`, `onSlashCommand`), `thread.post()`, streaming, JSX cards, state management |

### How to Use Skills
- **AI SDK questions**: Load the `ai-sdk` skill. It points to `node_modules/ai/docs/` and `node_modules/ai/src/` for current APIs. See `references/` for common errors, AI Gateway, type-safe agents, and devtools.
- **Chat SDK questions**: Load the `chat-sdk` skill. It points to `node_modules/chat/docs/` for MDX docs and `node_modules/chat/dist/` for types. Covers adapters, event handlers, streaming, cards, modals, and state.
- **Never guess APIs** - always verify against the skill docs or source code first.

---

## NOTES

- Vercel Chat SDK (`chat` package) was [open-sourced Feb 23, 2026](https://vercel.com/changelog/chat-sdk). It provides unified adapters for Discord, Slack, GitHub, Google Chat, Linear, and MS Teams.
- Chat SDK `post()` natively accepts AI SDK `textStream` for real-time streaming to platforms.
- Chat SDK uses `onNewMention` for first contact and `onSubscribedMessage` for follow-ups after `thread.subscribe()`.
- Chat SDK webhook handlers are exposed via `bot.webhooks.{platform}` - wire to your HTTP framework.
- Chat SDK supports JSX cards (`jsxImportSource: "chat"` in tsconfig) for interactive UI across platforms.
- Worker uses `installationId` to auth as GitHub App for each job.
- Subagent context is isolated by design (AI SDK pattern). This is a feature, not a bug - it keeps the orchestrator's context clean.
