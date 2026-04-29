<div align="center">

<img src="src/renderer/public/vibe-editor.png" alt="vibe-editor" width="112" />

# vibe-editor

**The desktop control room for [Claude Code](https://claude.com/code) & [Codex](https://openai.com/codex/).**

Spin up a *team* of AI coding agents. Watch them hand off work in real time. Drop everything onto an infinite canvas. Stay the reviewer in the loop.

[![Release](https://img.shields.io/github/v/release/yusei531642/vibe-editor?style=flat-square&color=ff7a59&label=release)](https://github.com/yusei531642/vibe-editor/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/yusei531642/vibe-editor/total?style=flat-square&color=ff7a59&label=downloads)](https://github.com/yusei531642/vibe-editor/releases)
[![Stars](https://img.shields.io/github/stars/yusei531642/vibe-editor?style=flat-square&color=ff7a59&label=stars)](https://github.com/yusei531642/vibe-editor/stargazers)
[![License](https://img.shields.io/badge/license-MIT-ff7a59?style=flat-square)](LICENSE)
[![Built with Tauri](https://img.shields.io/badge/built%20with-Tauri%202-24c8db?style=flat-square&logo=tauri&logoColor=white)](https://tauri.app/)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS*%20%7C%20Linux*-555?style=flat-square)](#install)

[**English**](README.md) · [日本語](README-ja.md) · [Releases](https://github.com/yusei531642/vibe-editor/releases) · [Issues](https://github.com/yusei531642/vibe-editor/issues)

![vibe-editor demo](docs/demo.gif)

</div>

---

## TL;DR

`vibe-editor` is **not** another AI code editor.

It is a **multi-agent dispatcher** for Claude Code and Codex. You tell a **Leader agent** what you want, the Leader **dynamically recruits a team** of workers tuned for the job, messages are **pty-injected directly into each agent's prompt** through an embedded MCP hub (no polling, no file queues, no latency), and you watch + redirect from a single Tauri desktop window — or rearrange agents, files, diffs, and terminals on an **infinite canvas**.

The built-in editor, git diff, file tree, and session history exist to support that **review loop** — not to compete with your real IDE.

> ⭐ **If this resonates, star the repo.** Every star helps surface the project to the next person drowning in 8 simultaneous Claude Code terminals.

![vibe-editor screenshot](docs/screenshot.png)

---

## Why vibe-editor

|                          | Cursor / Windsurf | VSCode + Claude Code | Plain terminal × N | **vibe-editor** |
|---|:-:|:-:|:-:|:-:|
| Driven by **Claude Code / Codex CLI** as-is | ❌ | ✅ | ✅ | ✅ |
| **Multiple agents** in one window | ❌ | △ | △ | **✅ (up to 30)** |
| Agents **delegate to each other** in real time | ❌ | ❌ | ❌ | **✅ (pty inject)** |
| **Infinite canvas** (any agent / file / diff anywhere) | ❌ | ❌ | ❌ | **✅** |
| Resume past sessions with `claude --resume` UI | ❌ | △ | manual | **✅** |
| Auto-restore your team after restart | ❌ | ❌ | ❌ | **✅** |
| Silent auto-update from GitHub Releases | ✅ | n/a | n/a | **✅** |

---

## Table of contents

- [Install](#install)
- [Prerequisites](#prerequisites)
- [Highlights](#highlights)
  - [Dynamic Team — one Leader, dynamically recruited workers](#dynamic-team--one-leader-dynamically-recruited-workers)
  - [Infinite Canvas mode](#infinite-canvas-mode)
  - [Terminal workspace](#terminal-workspace)
  - [Files, Changes, History](#files-changes-history)
  - [Polish](#polish)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Run from source](#run-from-source)
- [Architecture](#architecture)
- [Philosophy](#philosophy)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Install

The fastest path: grab the latest Windows installer from the [Releases](https://github.com/yusei531642/vibe-editor/releases/latest) page.

1. Download `vibe-editor-Setup-1.3.1.exe` (or the latest version listed there)
2. Run it. Install is **one-click silent** — no setup wizard — and auto-launches vibe-editor on finish.
3. Future updates are **fully silent**: the built-in auto-updater pulls new releases from GitHub in the background and restarts the app without any dialogs.

### If Windows SmartScreen blocks the installer

The build is not code-signed (no Authenticode certificate). Pick whichever you prefer:

- **SmartScreen "More info" → "Run anyway"** — easiest. Or right-click the `.exe` → Properties → tick "Unblock" → OK.
- **Switch Smart App Control to "Evaluation"** — Settings → Privacy & security → Windows Security → App & browser control → Smart App Control → **Evaluation**. Only known-bad apps get blocked.
  - ⚠️ Don't pick "Off" — turning it back on requires a full Windows reinstall. "Evaluation" is the sweet spot.
- **Build locally** — `git clone … && npm install && npm run build` and verify the binary yourself.

### Install location

One-click installs go to `%LOCALAPPDATA%\Programs\vibe-editor\` (user-scope, no admin). Uninstall via Windows "Installed apps". Settings and team history persist in `%APPDATA%\vibe-editor\` and survive uninstall.

### macOS / Linux

Pre-built binaries are not yet published. Build from source — Tauri produces `.dmg` / `.app` / `.deb` / `.AppImage` / `.rpm` artifacts:

```bash
git clone https://github.com/yusei531642/vibe-editor.git
cd vibe-editor
npm install
npm run build      # → src-tauri/target/release/bundle/
```

If you ship a working binary on macOS or Linux, please open a PR with notes — I'll happily fold platform-specific paths into the docs.

---

## Prerequisites

- **[Claude Code CLI](https://claude.com/code)** on `PATH` as `claude` — the core dependency. Install from the link and confirm `claude --version` works in a terminal.
- **Git** on `PATH` — used by the Changes panel and diff viewer.
- **Node.js 20+** — only if you build from source.
- **Rust toolchain** (`rustup`) — only if you build from source.

You do *not* need Python, C++ build tools, or `node-gyp`. The pty layer lives in Rust (`portable-pty`); the renderer is pure JS.

---

## Highlights

### Dynamic Team — one Leader, dynamically recruited workers

The team architecture was rewritten in v1.3 to remove fixed worker roles. Instead:

- You launch **one Leader** (Claude Code or Codex) from the **Dynamic Team** preset (1-click).
- You give the Leader your goal in natural language.
- The Leader calls `team_recruit(role_definition=…)` to spawn however many workers it needs, each with a custom role definition. Need a tester? An auth specialist? A migration auditor? The Leader designs and hires them on the spot.
- An **HR meta-role** is available for bulk-hiring sprees.
- Behavioral rules and tool docs live in a **`vibe-team` Skill** auto-installed at `.claude/skills/vibe-team/SKILL.md` — Claude auto-loads it. You don't memorize protocols.

**Real-time message delivery, no polling.** When the Leader calls `team_send("worker-3", "rebase onto main")`, the message is **injected directly into worker-3's input prompt** by the in-process **TeamHub** (`src-tauri/src/team_hub/`). It uses bracketed paste so multi-line / Unicode payloads up to ~32 KiB pass through cleanly on Windows ConPTY.

**Persistence.** Every team you create is saved to `~/.vibe-editor/team-history.json`. On next launch the team can be auto-restored — each member resumes its own Claude Code session via `claude --resume <session-id>`.

### Infinite Canvas mode

Press `Ctrl+Shift+M` to flip the entire workspace into **Canvas** mode — an infinite [`@xyflow/react`](https://reactflow.dev/) canvas where you can place six kinds of cards anywhere:

- **AgentNode** — full live terminal of a Claude Code / Codex session, draggable as a card. Team-locked groups move and resize together.
- **Terminal** — a free-floating shell pane.
- **Editor** — Monaco editor for any project file, with autosave indicator.
- **FileTree** — pinned file tree card.
- **Changes** — git status of the current branch.
- **Diff** — Monaco `DiffEditor` for a single changed file.

Cards remember their position per-project. Drag the Leader and its workers into a column on the left, files in the middle, diffs on the right — whatever spatial mental model you want, the canvas keeps. `Ctrl+Shift+M` again returns to the classic IDE layout. Both layouts share state so you can toggle freely mid-task.

### Terminal workspace

- Up to **30 concurrent Claude Code / Codex terminals**, auto-arranged in a 2/3/4/5-column grid.
- Drag-to-reorder panes without restarting the underlying session.
- Per-role colored labels, Leader crown, team group rendering.
- `Ctrl+V` an image in the terminal → saved to a temp file → absolute path injected at the cursor (ready for Claude to read).
- WebGL renderer with automatic context budget (max 8 active) and graceful fallback so 30 terminals don't kill the GPU.

### Files, Changes, History

Three-tab sidebar:

- **Files** — lazy-loading tree with sensible excludes (`.git`, `node_modules`, `out`, `dist`, …). Click → opens in a Monaco tab. `Ctrl+S` saves atomically (tmp → rename) with a dirty indicator and unsaved-edit confirm.
- **Changes** — `git status --porcelain=v1 -z` powered. Click → side-by-side or inline diff in Monaco `DiffEditor`. Right-click → "Ask Claude Code to review this diff" sends a prompt to the active terminal. Binary files get a placeholder, not garbled bytes.
- **History** — browses `~/.claude/projects/<encoded>/*.jsonl` (every past Claude Code session for this project) and your saved teams. Click → spawns a new tab with `claude --resume <id>`.

### Polish

- 5 themes — `claude-dark` (default) / `claude-light` / `dark` / `midnight` / `light`
- 3 density modes — `compact` / `normal` / `comfortable`
- Japanese-first typography (Notion JP style — Yu Gothic stack, 1.75 line-height, kerning)
- Acrylic / Mica window effects on Windows 11
- Tray icon for fast restore
- `lucide-react` icon set
- Markdown preview alongside the Monaco editor
- Self-installing **vibe-team Skill** so Claude follows team protocols without manual prompting
- Silent **auto-updater** via `tauri-plugin-updater` against GitHub Releases — signed update manifest, resumable downloads

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+P` | Command palette (fuzzy search every action) |
| `Ctrl+Shift+M` | Toggle Canvas / IDE mode (also `Cmd+Shift+M` on macOS) |
| `Ctrl+,` | Settings |
| `Ctrl+S` | Save active editor tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle tabs |
| `Ctrl+W` | Close active tab |
| `Ctrl+Shift+T` | Reopen last closed tab |

---

## Run from source

```bash
git clone https://github.com/yusei531642/vibe-editor.git
cd vibe-editor
npm install
npm run dev
```

Tauri launches with a single Claude Code terminal tab. Open any folder via the project menu (top left) or `Ctrl+Shift+P` → "Open folder…".

### Other scripts

```bash
npm run typecheck    # tsc --noEmit (strict)
npm run dev:vite     # Renderer only (no Rust)
npm run build        # cargo tauri build → src-tauri/target/release/bundle/
npm run icons        # Regenerate build/icon.ico from build/icon.svg
```

---

## Architecture

```
src-tauri/                       # Rust side (Tauri host)
├── src/
│   ├── main.rs                  # Tauri app entry, updater init
│   ├── lib.rs                   # invoke handler wiring
│   ├── commands/                # IPC handlers (app/git/terminal/settings/sessions/files/team_history/…)
│   ├── pty/                     # portable-pty + batcher + Claude session watcher
│   ├── team_hub/                # TCP JSON-RPC MCP hub + embedded team-bridge.js + inject
│   └── mcp_config/              # ~/.claude.json & ~/.codex/config.toml writers
├── Cargo.toml
└── tauri.conf.json

src/renderer/src/                # React 18 + TypeScript, UI only
├── App.tsx
├── components/
│   ├── canvas/                  # @xyflow/react infinite-canvas mode
│   │   └── cards/               # AgentNode / Terminal / Editor / FileTree / Changes / Diff
│   └── …
├── layouts/                     # CanvasLayout, …
├── stores/                      # zustand (ui, canvas)
└── lib/                         # themes, i18n, tauri-api, commands, role-profiles, …
```

### How TeamHub works

```
 ┌────────────── Rust host (src-tauri) ──────────────┐
 │                                                   │
 │  TeamHub                                          │
 │   ├─ TCP JSON-RPC on 127.0.0.1:rand               │
 │   ├─ 24-byte auth token                           │
 │   ├─ agentId → pty registry                       │
 │   └─ team_send → bracketed-paste pty.write inject │
 │                                                   │
 │  commands/terminal.rs owns the ptys (portable-pty)│
 └───────────────────────────────────────────────────┘
          ▲                  ▲
    stdio MCP           stdio MCP
 ┌────┴──────┐      ┌────┴──────┐
 │ Claude A  │      │ Claude B  │
 │ bridge.js │      │ bridge.js │ ← ~60 LOC TCP passthrough
 └───────────┘      └───────────┘
```

- On startup the Rust `TeamHub` opens a local TCP JSON-RPC server with a random port + 24-byte auth token.
- A tiny `team-bridge.js` is written to `%APPDATA%\vibe-editor\team-bridge.js` and registered as the `vibe-team` MCP server in `~/.claude.json` and `~/.codex/config.toml`.
- When Claude Code spawns `vibe-team`, the bridge connects to the hub via TCP using the token.
- `team_send(to, message)` resolves the target `agentId` → pty and calls `pty.write(message + '\r')` directly **using bracketed paste** so multi-line and Unicode payloads survive ConPTY.
- Long payloads (>~32 KiB) are rejected at the hub; the worker is told to stash the content into `.vibe-team/tmp/<id>.md` and send a summary + path instead.
- On app shutdown the hub stops and MCP config entries are cleaned up (graceful uninstall).

### Constraints

- Rust host owns: filesystem, git, pty, dialogs, the TeamHub TCP server, auto-updater.
- Renderer is pure UI: every side effect goes through `@tauri-apps/api/core` `invoke()` + `listen()`.
- TypeScript strict mode across the renderer codebase.

---

## Philosophy

This is not a code editor. It is a **review surface and team dispatcher for Claude Code**:

- You do not edit `CLAUDE.md` by hand — Claude does.
- You do not enable skills — Claude auto-loads them by description.
- You do not write functions — you describe what you want in the terminal and Claude writes them.
- You **coordinate** multiple Claudes with roles, review their diffs, and redirect.

The UI's job is to get out of the way.

---

## Roadmap

- [x] Multi-agent teams with real-time pty-inject delivery
- [x] Canvas mode with 6 card types (Agent / Terminal / Editor / FileTree / Changes / Diff)
- [x] Dynamic Team architecture (Leader + HR + dynamic recruit)
- [x] Auto team restoration on app restart
- [x] Markdown preview alongside Monaco editor
- [x] Silent Windows auto-updater
- [ ] **Token usage / cost dashboard** for Claude Code sessions
- [ ] **CLAUDE.md & Skill management UI** (templates, toggle on/off, browse global skills)
- [ ] **macOS / Linux signed pre-built binaries**
- [ ] **Team activity replay** — scrub time backwards across all members
- [ ] **MCP server browser** — drop-in install for popular MCP servers

Have an idea? [Open an issue](https://github.com/yusei531642/vibe-editor/issues) or jump into [Discussions](https://github.com/yusei531642/vibe-editor/discussions).

---

## Contributing

PRs welcome — especially:

- macOS / Linux build verification (the bundle targets are configured but rarely exercised)
- Theme contributions (drop into `src/renderer/src/lib/themes.ts`)
- Translation beyond JP/EN (i18n strings live in `src/renderer/src/lib/i18n.ts`)
- Role profile presets (`~/.vibe-editor/role-profiles.json` schema in `src/types/shared.ts`)

Quick dev loop:

```bash
git clone https://github.com/yusei531642/vibe-editor.git
cd vibe-editor && npm install
npm run dev          # Tauri + Vite hot reload
npm run typecheck    # before pushing
```

If you ship something cool with vibe-editor — multi-agent workflows, recorded demos, screenshots — please share in [Discussions](https://github.com/yusei531642/vibe-editor/discussions) so others can learn from it.

---

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Anthropic or OpenAI. "Claude Code" is a product of [Anthropic](https://anthropic.com/); "Codex" is a product of [OpenAI](https://openai.com/).

---

<div align="center">

If vibe-editor saved you from juggling 12 terminal windows, **[give it a star ⭐](https://github.com/yusei531642/vibe-editor)**.

</div>
