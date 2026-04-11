# claude-editor

[English](README.md) · [日本語](README-ja.md)

![claude-editor](docs/screenshot.png)

> A minimal desktop companion for [Claude Code](https://claude.com/code) — **vibe coding with a warm, focused UI.**

claude-editor is an Electron-based desktop shell designed around a single idea: **let Claude write the code, and let the human review.** There is no text editor. The main area is for diff review; the right panel is a persistent Claude Code terminal; the left panel shows what changed and past sessions.

---

## Features

- **Fixed Claude Code terminal panel** — Claude Code session runs always-on in the right pane, drag to resize
- **Session history & resume** — browses `~/.claude/projects/*/session.jsonl`; click a past session to continue it with `claude --resume <id>`
- **Changes panel** — git status integration; click a changed file to open a side-by-side diff tab
- **Diff review tabs** — Monaco `DiffEditor`, inline / side-by-side toggle, pin / close / reorder
- **Command palette** — `Ctrl+Shift+P` with fuzzy search for every action
- **Project switcher** — open any folder as a project, terminal auto-restarts in the new cwd, recent projects list
- **Image paste in terminal** — `Ctrl+V` an image from the clipboard in the Claude Code terminal → auto-saved to a temp file and the absolute path is inserted at the cursor (ready for Claude to read)
- **Themes** — `claude-dark` (default) / `claude-light` / `dark` / `midnight` / `light`
- **Density settings** — `compact` / `normal` / `comfortable`
- **SVG icons throughout** — [lucide-react](https://lucide.dev/)
- **Claude.ai inspired design language** — warm dark palette, Source Serif Pro headings, coral accent `#D97757` used sparingly for primary actions

---

## Requirements

- **Node.js 20+**
- **Git** on `PATH`
- **Claude Code CLI** (`claude`) on `PATH` — see [claude.com/code](https://claude.com/code)
- Windows 10+, macOS 12+, or Linux
- Python 3 + C++ build tools are **not** normally required (node-pty ships NAPI prebuilds)

---

## Install & run (dev)

```bash
git clone https://github.com/<your-user>/claude-editor.git
cd claude-editor
npm install
npm run dev
```

Electron will open with the Claude Code terminal running in the right pane.

---

## Build (production)

```bash
npm run typecheck        # TypeScript strict check
npm run build            # electron-vite build → out/
npm run dist:win         # Windows NSIS installer → release/
npm run dist             # Current platform installer (current OS)
```

The built Windows installer lands at `release/claude-editor Setup 0.1.0.exe` (~100 MB). A portable unpacked app is also produced at `release/win-unpacked/claude-editor.exe`.

### Icon regeneration

The app icon source lives at `build/icon.svg`. To regenerate the Windows `.ico` and the master PNG:

1. Start a local HTTP server serving `build/` (e.g. `py -m http.server 8766`)
2. Open `http://localhost:8766/render.html` in a Chromium-based browser with viewport set to 1100×1100
3. Save the screenshot to `build/icon-master.png`
4. Run `npm run icons`

(The two-step process exists because librsvg does not reliably resolve system serif fonts; rendering via Chromium gives correct typography for the serif "C".)

---

## Architecture

```
src/
├── main/                # Electron main process
│   ├── index.ts         # BrowserWindow, IPC registration, menu removal
│   └── ipc/
│       ├── app.ts       # getProjectRoot, restart, setWindowTitle
│       ├── dialog.ts    # folder/file pickers
│       ├── git.ts       # status + diff (HEAD vs worktree)
│       ├── sessions.ts  # parse ~/.claude/projects/*/*.jsonl
│       ├── settings.ts  # userData/settings.json persistence
│       └── terminal.ts  # node-pty spawn/write/resize, image paste save
├── preload/
│   └── index.ts         # contextBridge.exposeInMainWorld('api', ...)
├── renderer/            # React UI
│   └── src/
│       ├── App.tsx              # 3-column layout, state orchestration
│       ├── components/
│       │   ├── AppMenu.tsx
│       │   ├── ChangesPanel.tsx
│       │   ├── CommandPalette.tsx
│       │   ├── DiffView.tsx
│       │   ├── SessionsPanel.tsx
│       │   ├── SettingsModal.tsx
│       │   ├── Sidebar.tsx
│       │   ├── TabBar.tsx
│       │   ├── TerminalView.tsx
│       │   ├── Toolbar.tsx
│       │   └── WelcomePane.tsx
│       ├── lib/
│       │   ├── commands.ts          # fuzzy filter + Command type
│       │   ├── language.ts          # ext → Monaco language
│       │   ├── monaco-setup.ts      # Vite worker wiring
│       │   ├── parse-args.ts        # shell-like arg split
│       │   ├── settings-context.tsx # React Context for settings
│       │   ├── themes.ts            # CSS variable themes
│       │   └── toast-context.tsx    # toast notifications + Undo
│       ├── index.css
│       └── main.tsx
└── types/
    ├── ipc.d.ts         # window.api global declaration
    └── shared.ts        # main ↔ renderer shared types
```

### Design constraints

- **Main process** owns filesystem, git, node-pty, dialogs
- **Renderer** is pure UI — no direct Node.js imports, no `fs`, no `child_process`
- **All IPC** goes through `contextBridge` — `window.api.*`
- **TypeScript strict mode** across the entire codebase

### Key shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+,` | Open settings |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle diff tabs |
| `Ctrl+W` | Close active tab |
| `Ctrl+Shift+T` | Reopen last closed tab |

---

## Philosophy

This is not a code editor. It is a **review surface for Claude Code's output**:

- You do not edit `CLAUDE.md` by hand — Claude does.
- You do not enable skills — Claude auto-loads them by description.
- You do not write functions — you describe what you want in the terminal and Claude writes them.
- You review the diffs, approve or redirect, and repeat.

The UI's job is to get out of the way.

---

## License

MIT — see [LICENSE](LICENSE).

Not affiliated with Anthropic. "Claude Code" is a product of [Anthropic](https://anthropic.com/).
