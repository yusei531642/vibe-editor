# vibe-editor

[English](README.md) · [日本語](README-ja.md)

![vibe-editor](docs/screenshot.png)

> A minimal desktop companion for [Claude Code](https://claude.com/code) and [Codex](https://openai.com/codex/) — **vibe coding with a warm, focused UI, and a multi-agent team runtime built in.**

vibe-editor is an Electron-based desktop shell with one idea: **let agents write the code; the human reviews, redirects, and coordinates a team of agents.** It is not a text editor first. It is a **review surface** and **team orchestration layer** around Claude Code / Codex sessions.

---

## Install (Windows)

The fastest path: grab the latest Windows installer from the [Releases](https://github.com/yusei531642/vibe-editor/releases/latest) page.

1. Download `vibe-editor-Setup-1.0.0.exe`
2. Run it. Install is **one-click silent** — no setup wizard — and auto-launches vibe-editor on finish
3. Future updates are **fully silent**: the built-in auto-updater pulls new releases from GitHub in the background and restarts the app without any dialogs

### If Windows SmartScreen blocks the installer

The build is not code-signed (no Authenticode certificate). Choose whichever you prefer:

- **SmartScreen "More info" → "Run anyway"** — the easiest path. You can also right-click the `.exe` → Properties → tick "Unblock" → OK.
- **Switch Smart App Control to "Evaluation"** — Settings → Privacy & security → Windows Security → App & browser control → Smart App Control → **Evaluation**. Only known-bad apps get blocked.
  - ⚠️ Don't pick "Off" — turning it back on requires a full Windows reinstall. "Evaluation" is the sweet spot.
- **Build locally** — `git clone … && npm install && npm run dist:win` and verify the binary yourself.

### Install location

One-click installs go to `%LOCALAPPDATA%\Programs\vibe-editor\` (user-scope, no admin required). Uninstall via the Windows "Installed apps" list. Settings and team history persist in `%APPDATA%\vibe-editor\` and survive uninstall.

### macOS / Linux

Pre-built binaries are not yet published for macOS and Linux. Build from source:

```bash
git clone https://github.com/yusei531642/vibe-editor.git
cd vibe-editor
npm install
npm run dist        # outputs to release/
```

---

## Prerequisites

- **[Claude Code CLI](https://claude.com/code)** on `PATH` as `claude` — the core dependency. Install from the link and make sure `claude --version` works in a terminal.
- **Git** on `PATH` — used by the Changes panel.
- **Node.js 20+** — only if you plan to build from source.

You do *not* need Python, C++ build tools, or node-gyp — `node-pty` ships NAPI prebuilds.

---

## Features

### Multi-agent teams with real-time message delivery

- Create a team of 2–30 Claude Code or Codex instances with roles (**leader / planner / programmer / researcher / reviewer**)
- Leader waits for your instruction; members wait for the leader's delegation — nothing auto-starts
- **Direct pty injection** via an in-process MCP hub (`TeamHub`): when a leader calls `team_send("programmer", "...")`, the message is injected **directly into the programmer's input prompt in real time**. No file polling, no message queues, no latency.
- Team state persistence: every team you create is saved to `~/.vibe-editor/team-history.json`. Resume a team from the **History → Teams** sidebar and each member's Claude Code session picks up where it left off via `claude --resume <session>`
- Built-in presets (Dev Duo, Full Team, Code Squad) and custom presets you save yourself

### Terminal workspace

- Fixed Claude Code / Codex terminal panel, drag to resize
- Up to 30 concurrent terminals, auto-arranged in a 2/3/4/5-column grid
- Drag-to-reorder panes without restarting the underlying Claude Code session
- `Ctrl+V` an image in the terminal → saved to a temp file, absolute path inserted at the cursor (ready for Claude to read)
- Per-role colored labels, leader crown, team group rendering

### File tree + lightweight editor

- Three-tab sidebar: **Files** / **Changes** / **History**
- Lazy-loading file tree with a sensible exclude list (`.git`, `node_modules`, `out`, `dist`, ...)
- Click a file → opens in a Monaco-based editor tab with full syntax highlighting
- `Ctrl+S` saves atomically (tmp → rename). Dirty indicator in the tab bar. Confirmation before discarding unsaved edits.

### Git diff review

- Changes panel powered by `git status --porcelain=v1 -z`
- Click a changed file → side-by-side or inline diff in Monaco `DiffEditor`
- Right-click → "Ask Claude Code to review this diff" (sends a prompt to the active terminal)
- Binary files detected and shown as a placeholder instead of garbled text

### Session history

- Browses `~/.claude/projects/<encoded>/*.jsonl` — every past Claude Code session for this project
- Click any entry to spawn a new tab with `claude --resume <id>`
- Team sessions are shown as a separate section at the top of the History tab

### Auto-updater

- Background update checks on startup via `electron-updater` against GitHub Releases
- Silent NSIS install on completion — no setup wizard, no "Run anyway" prompts on update
- Downloads resume on failure, TLS settings hardened for GitHub CDN

### Theming and polish

- Five themes: `claude-dark` (default) / `claude-light` / `dark` / `midnight` / `light`
- Three density modes: `compact` / `normal` / `comfortable`
- Japanese-first typography (Notion JP style — Yu Gothic stack, 1.75 line-height, kerning)
- Layered shadows, spring animations, noise overlay on accent surfaces
- `lucide-react` icons everywhere

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+P` | Command palette (fuzzy search every action) |
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

Electron launches with a single Claude Code terminal tab. Open any folder via the project menu (top left) or `Ctrl+Shift+P` → "Open folder…".

### Other scripts

```bash
npm run typecheck    # tsc --noEmit (strict)
npm run build        # electron-vite build → out/
npm run dist:win     # Windows NSIS installer → release/
npm run dist         # Current-OS installer
npm run icons        # Regenerate build/icon.ico and installer BMPs from build/icon.svg
```

---

## Architecture

```
src/
├── main/                       # Electron main process
│   ├── index.ts                # BrowserWindow, IPC registration, auto-updater init
│   ├── team-hub.ts             # In-process TCP JSON-RPC MCP hub + team-bridge.js generator
│   ├── updater.ts              # electron-updater wiring + silent install
│   └── ipc/
│       ├── app.ts              # getProjectRoot, restart, setupTeamMcp, Claude MCP registration
│       ├── dialog.ts           # folder/file pickers
│       ├── files.ts            # list/read/write for the file tree + simple editor
│       ├── git.ts              # status + diff (HEAD vs worktree)
│       ├── sessions.ts         # parse ~/.claude/projects/*/*.jsonl + session dir utils
│       ├── settings.ts         # userData/settings.json persistence
│       ├── team-history.ts     # per-project team history JSON store
│       └── terminal.ts         # node-pty spawn/write/resize, image paste, session watcher
├── preload/
│   └── index.ts                # contextBridge.exposeInMainWorld('api', ...)
└── renderer/src/
    ├── App.tsx                 # layout + state orchestration
    ├── components/
    │   ├── AppMenu.tsx
    │   ├── ChangesPanel.tsx
    │   ├── CommandPalette.tsx
    │   ├── DiffView.tsx
    │   ├── EditorView.tsx
    │   ├── FileTreePanel.tsx
    │   ├── SessionsPanel.tsx
    │   ├── SettingsModal.tsx
    │   ├── Sidebar.tsx
    │   ├── TabBar.tsx
    │   ├── TeamCreateModal.tsx
    │   ├── TerminalView.tsx
    │   ├── Toolbar.tsx
    │   └── WelcomePane.tsx
    └── lib/
        ├── commands.ts         # fuzzy filter + Command type
        ├── i18n.ts             # ja / en flat-key dict
        ├── language.ts         # ext → Monaco language
        ├── monaco-setup.ts     # Vite worker wiring
        ├── parse-args.ts       # shell-like arg split
        ├── settings-context.tsx
        ├── themes.ts           # CSS variable themes
        └── toast-context.tsx
```

### How TeamHub works

```
 ┌──────── Electron main process ────────┐
 │                                       │
 │  TeamHub                              │
 │   ├─ TCP JSON-RPC on 127.0.0.1:rand   │
 │   ├─ agentId → pty registry           │
 │   └─ team_send → pty.write() inject   │
 │                                       │
 │  terminal.ts owns the ptys            │
 └───────────────────────────────────────┘
          ▲                  ▲
    stdio MCP           stdio MCP
 ┌────┴──────┐      ┌────┴──────┐
 │ Claude A  │      │ Claude B  │
 │ bridge.js │      │ bridge.js │ ← ~60 LOC TCP passthrough
 └───────────┘      └───────────┘
```

- On startup, `TeamHub.start()` opens a local TCP JSON-RPC server with a random port + 24-byte auth token
- A tiny `team-bridge.js` is written to `%APPDATA%\vibe-editor\team-bridge.js` and registered as the `vive-team` MCP server in `~/.claude.json` and `~/.codex/config.toml`
- When Claude Code spawns `vive-team`, the bridge connects to the hub via TCP using the token
- `team_send(to, message)` on the hub resolves the target `agentId` → pty and calls `pty.write(message + '\r')` directly. No file polling.
- UTF-8 safe chunked writes handle long messages on Windows ConPTY
- On unmount, the hub stops, the JSON config entries remain (no cleanup of other users' state)

### Constraints

- Main process owns: filesystem, git, node-pty, dialogs, the TeamHub TCP server
- Renderer is pure UI: no direct `fs` / `child_process` / Node imports
- All IPC through `contextBridge.exposeInMainWorld('api', ...)`
- TypeScript strict mode across the whole codebase

---

## Philosophy

This is not a code editor. It is a **review surface and team dispatcher for Claude Code**:

- You do not edit `CLAUDE.md` by hand — Claude does.
- You do not enable skills — Claude auto-loads them by description.
- You do not write functions — you describe what you want in the terminal and Claude writes them.
- You **coordinate** multiple Claudes with roles, review their diffs, and redirect.

The UI's job is to get out of the way.

---

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Anthropic or OpenAI. "Claude Code" is a product of [Anthropic](https://anthropic.com/); "Codex" is a product of [OpenAI](https://openai.com/).
