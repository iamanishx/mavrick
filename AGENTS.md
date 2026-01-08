# PROJECT KNOWLEDGE BASE

**Generated:** 2026-01-08
**Framework:** Probot (GitHub Apps) + BullMQ + Docker

## OVERVIEW
AxeAI Test Bot creates autonomous integration tests for PRs using AI agents running in secure Docker sandboxes. It decouples webhook handling (Probot) from execution (BullMQ Worker).

## STRUCTURE
```
.
├── src/
│   ├── index.ts      # Webhook Listener -> Producer (Adds to Redis)
│   ├── worker.ts     # Consumer -> Spawns Docker Sandbox
│   ├── agent.ts      # Ralph Loop Agent (AI Logic)
│   └── sandbox.ts    # Dockerode Abstraction (Container Mgmt)
└── package.json      # Scripts: build, start, dev
```

## WHERE TO LOOK
| Task | Location | Notes |
|------|----------|-------|
| **Event Handling** | `src/index.ts` | Listens for `@axeai-bot` |
| **Job Processing** | `src/worker.ts` | Concurrency limit: 2 |
| **AI Logic** | `src/agent.ts` | Uses `ralph-loop-agent` |
| **Isolation** | `src/sandbox.ts` | `node:20-slim` containers |

## CONVENTIONS
- **Queues**: Webhooks MUST NOT execute heavy logic. Push to `test-generation` queue.
- **Sandboxing**: File ops MUST go through `DockerSandbox`. Host execution is FORBIDDEN.
- **Git**: Clone/Commit/Push happens INSIDE the container via `sandbox.exec()`.

## ANTI-PATTERNS (THIS PROJECT)
- **Direct FS Access**: Never use `fs.writeFile` on host for user code.
- **Synchronous AI**: Never await OpenAI in `index.ts`.
- **Root execution**: Agent commands run as root in container; ensure ephemeral.

## COMMANDS
```bash
# Dev (Requires Redis + Docker)
npm run dev

# Build
npm run build

# Start (Production)
npm start
```

## NOTES
- Requires `REDIS_HOST` and `DOCKER_HOST` (or socket).
- Worker uses `installationId` to auth as App for each job.
