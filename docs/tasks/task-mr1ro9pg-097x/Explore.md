# multiAgentChat Project Overview

## 1. What the Project Is

**multiAgentChat** is a local macOS daemon that bridges Feishu (飞书) instant messaging with multiple Claude Code terminal tabs. It enables single-user asynchronous task orchestration from a mobile phone or Feishu interface: send commands like `@ttys001 run tests` to dispatch to a specific terminal tab, view real-time progress in Feishu cards, and execute multi-stage Standard Operating Procedures (SOPs) with human approval gates. The core differentiator is **terminal-first** design—it observes and controls Claude Code tabs you already have open, rather than spawning new processes. Built in TypeScript/Node.js, it runs as a daemon on macOS with AppleScript controlling Terminal.app via local Unix socket CLI integration.

---

## 2. Top-Level Directory Layout

```
multiAgentChat/
├── apps/
│   └── daemon/              Main daemon application (Feishu ↔ Terminal bridge)
├── packages/
│   ├── framework/           Unix socket control server + agent CLI + protocol types
│   ├── host-mac/            macOS host controller (AppleScript Terminal.app integration)
│   ├── im-lark/             Feishu IM transport + cards + watcher/notifier
│   └── orchestrator/        Pure task state / stage / gate / memory / approval logic
├── bin/
│   └── agent                CLI shim executable (resolves to monorepo root)
├── data/                    Runtime persistence (JSON stores for tasks, memories, chats, approvals)
├── docs/                    Architecture & design documentation
├── .claude/                 Claude Code project configuration
├── pnpm-workspace.yaml      pnpm monorepo workspace definition
├── package.json             Root package (defines dev scripts + agent CLI bin)
├── README.md                User-facing quickstart & command reference
├── CLAUDE.md                Developer guide & architecture notes
├── .env.example             Template for Feishu app credentials
└── tsconfig.json            TypeScript configuration for workspace
```

---

## 3. Packages Breakdown

### **multiagent-orchestrator** (`packages/orchestrator/`)
Pure state machine & logic layer—IM-agnostic and host-agnostic. Manages SOP task definitions, stage progression, approval gates, task-level & stage-level memory persistence, and templating. Exports submodules: `./tasks` (TaskState, TaskStatus, stage flow), `./presets` (template store), `./memory` (long-term task memory), `./approval` (approval request management). Contains no Feishu or Terminal.app specifics; can be reused for other IM platforms or host controllers.

### **multiagent-host-mac** (`packages/host-mac/`)
macOS-specific host controller. Wraps AppleScript via `osascript` to list Terminal.app tabs, send text to tabs, detect tab status (idle/busy/TUI mode), open new tabs at specific cwd, and extract scrollback history via `contents of tab` / `history of tab`. Handles Claude TUI alt-screen mode quirks (detects via char-length rather than line-count). Exports `terminal/tabs.ts` (listTabs, send, forceEnter), `terminal/applescript.ts` (runOsascript wrapper), `workspace.ts` (cwd management), `recent-cwds.ts` (LRU tracking).

### **multiagent-framework** (`packages/framework/`)
Cross-cutting infrastructure: Unix domain socket control server (`control/server.ts`), `agent` CLI client (`control/cli.ts`), and shared protocol types (`control/protocol.ts`). Implements all `agent <cmd>` subcommands (tabs, send, open, lark, approvals, task, etc.), socket request/response serialization, and CLI argument parsing. Bridges between daemon and shell scripts/claudeCode sessions.

### **multiagent-im-lark** (`packages/im-lark/`)
Feishu-specific transport & UI. Integrates `@larksuiteoapi/node-sdk` for WebSocket long-connection, message ingestion, and card rendering. Implements Feishu command handlers (`/dashboard`, `/run`, `/template`, etc.), interactive card schemas (progress cards, batch cards, approval cards, dashboard), real-time output watcher/notifier, chat-level state persistence, and call-retry logic. Tightly coupled to Feishu currently; future refactoring will extract generic bridge layer.

---

## 4. Apps Breakdown

### **multiagent-daemon** (`apps/daemon/`)
The main entry point and orchestrator. Single Node.js process that coordinates all subsystems: starts Feishu WebSocket client, installs control server on Unix socket, runs background output watcher (3-second tick polling Terminal.app history), manages approval workflow, tracks pending tasks with memory persistence, and routes incoming Feishu messages to Terminal tabs. Composes `multiagent-orchestrator`, `multiagent-host-mac`, `multiagent-framework`, and `multiagent-im-lark`. Implements health checks (30-second HTTP probe to Feishu, 3 failures trigger self-suicide), WebSocket watchdog (detects silent disconnects), and graceful reload via `tsx watch`.

---

## 5. The `agent` CLI

**Entry point:** `bin/agent` (bash shim) → `packages/framework/src/control/cli.ts`

Subcommands exposed via `agent <cmd>`:

- **Tab control:** `tabs`, `use <tty>`, `which`, `send -t <tty> <text>`, `open [path]`, `close <tty>`, `show -t <tty> [-n lines]`
- **Chat management:** `chat <chatId>` (query active tab), `recent-cwds` (LRU cwd list)
- **Lark integration:** `lark send-text <msg>`, `lark send-file <path>`, `lark send-image <path>` (auto-resolve chat from current tty)
- **Approvals:** `approvals` (list pending/history), `approve <reqId>`, `reject <reqId>`, `request-approval --title T --body B` (blocking call)
- **Task orchestration:** `task [list|show <id>]`, `task stage --task-id X --name N [--start|--end|--fail]`, `stage-recall [--name N] [--cwd C] [keywords...]` (search task memory)
- **Skill management:** `install-skill`, `uninstall-skill` (manages ~/.claude/skills/multiagent-lark/)
- **Subagent:** `subagent [list|add|delete|show]` (registry of remote/local agents)
- **Help:** `help` (full command list)

All commands communicate via JSON-RPC over Unix socket (`~/.multiagent-chat/agent.sock`) to the daemon.

---

## 6. Tech Stack & Build

**Monorepo:** pnpm workspaces with TypeScript.

**Runtime:** Node.js ≥20; executed via `tsx` (TypeScript executor).

**Key dependencies:**
- `@larksuiteoapi/node-sdk` v1.40.0 (Feishu SDK)
- `dotenv` (`.env` config loading)
- Internal workspace packages (orchestrator, host-mac, framework, im-lark) linked via `workspace:*`

**Build system:**
- `npm run dev` → `tsx watch apps/daemon/src/index.ts` (live reload on file change)
- `npm run build` → `tsc -b` (TypeScript incremental build to `dist/`)
- `npm run typecheck` → `tsc -b --pretty` (type checking without emit)
- `npm start` → `tsx apps/daemon/src/index.ts` (production run)

**Configuration:**
- `.env` (gitignored): `LARK_APP_ID`, `LARK_APP_SECRET`
- `.npmrc`: pnpm config
- `tsconfig.json` + per-package `tsconfig.json`: TypeScript settings with composite projects

---

## 7. Current Development Focus

From recent commits (git log last 8):
1. **Phase 1b step 2-4 (ea4992c):** Extracted `multiagent-orchestrator` package as independent pure-logic layer
2. **Phase 1b step 2-4 (3dae552):** Split monolith into `host-mac`, `im-lark`, `framework` packages
3. **Phase 1a (2159225):** pnpm workspaces bootstrap & initial monorepo restructuring
4. **P0: subagent registry (07d42af):** Added subagent registry + gen-submit flow for federated agent management

**Active work:** Monorepo phase 1 completion (package extraction → v4.0 A route: orchestration, templates, chains, planning). The codebase is mid-refactor from monolith to composable packages.

---

## 8. Data & State Persistence

**Runtime directories:**

- `~/.multiagent-chat/`
  - `agent.sock` — Unix domain socket (control server listening point)
  - `cli-state.json` — CLI's current TTY preference
  - `presets/` — Task templates (JSON manifests)

- `./data/` (project root)
  - `chats/<chatId>.json` — Per-chat state (active TTY, watch flags)
  - `tasks/<taskId>.json` — SOP task state machine & stage progress
  - `memories/<taskId>.json` — Task-level memory (output extracts, files produced, metadata)
  - `stage-memories/<stageId>.json` — Stage-level memory within tasks
  - `approvals/<reqId>.json` — Approval request records & status
  - `recent-cwds.json` — LRU list of recently used working directories

All state uses JSON-based file storage with in-memory synchronization; no external database required.

