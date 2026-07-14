#!/usr/bin/env node
// Issue #931: `#[tauri::command]` の戻り値型を CI で検査する tripwire。
//
// IPC の失敗表現は `commands/error.rs` の `CommandResult<T>` (`Err` は `{ code, message }`
// の構造化 CommandError) に統一する。`Option<T>` (失敗とキャンセルの黙殺) や
// `ok: bool + error: Option<String>` 埋め込みなど、過去の 3 流派が「コピーできる前例」
// として並んでいると、新規コマンドがどれを真似ても compile が通ってしまうため、
// CommandResult 以外の戻り値を持つ command を検出して fail させる。
//
// 既存の違反 (旧流派で書かれた command) は BASELINE_EXEMPT に列挙して固定する。
// **新規 command を BASELINE_EXEMPT に足さない**こと。やむを得ない場合は該当
// `#[tauri::command]` 行の直前に
//   // command-result-exempt: <理由>
// を書いて明示的に opt-out する (理由なしの exempt は review で弾く運用)。
// BASELINE の violation を CommandResult へ移行する PR では、このリストから削る。
//
// 制限: 行ベースの軽量 parse なので、`fn` シグネチャが極端に変則的な場合は誤判定しうる。
// これは「うっかり旧流派をコピーする」支配的パターンを止める tripwire であり、
// 完全な型検査ではない (それは clippy / コンパイラの領分)。

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const scanRoot = join(repoRoot, 'src-tauri', 'src');
const EXEMPT_MARKER = 'command-result-exempt';

// Issue #931 時点の既存違反 (file::fn)。旧 3 流派で書かれた command の baseline。
const BASELINE_EXEMPT = new Set([
  'commands/app/team_mcp.rs::app_get_team_file_path',
  'commands/app/window.rs::app_check_claude',
  'commands/app/window.rs::app_set_window_effects',
  'commands/app/window.rs::app_open_external',
  'commands/app/window.rs::app_reveal_in_file_manager',
  'commands/app.rs::app_get_project_root',
  'commands/app.rs::app_restart',
  'commands/app.rs::app_get_user_info',
  'commands/dialog.rs::dialog_open_folder',
  'commands/dialog.rs::dialog_open_file',
  'commands/dialog.rs::dialog_is_folder_empty',
  'commands/files.rs::files_list',
  'commands/files.rs::files_read',
  'commands/files.rs::files_write',
  'commands/files.rs::files_create',
  'commands/files.rs::files_create_dir',
  'commands/files.rs::files_rename',
  'commands/files.rs::files_delete',
  'commands/files.rs::files_copy',
  'commands/git.rs::git_status',
  'commands/git.rs::git_diff',
  'commands/mod.rs::ping',
  'commands/role_profiles.rs::role_profiles_load',
  'commands/sessions.rs::sessions_list',
  'commands/team_history.rs::team_history_list',
  'commands/team_presets.rs::team_presets_list',
  'commands/team_presets.rs::team_presets_load',
  'commands/team_presets.rs::team_presets_save',
  'commands/team_presets.rs::team_presets_delete',
  'commands/terminal.rs::terminal_save_pasted_image',
  'commands/terminal_tabs.rs::terminal_tabs_load',
  'commands/terminal_tabs.rs::terminal_tabs_save',
  'commands/terminal_tabs.rs::terminal_tabs_clear'
]);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (name.endsWith('.rs')) out.push(p);
  }
  return out;
}

const violations = [];
for (const file of walk(scanRoot)) {
  const rel = relative(scanRoot, file).replace(/\\/g, '/');
  const lines = readFileSync(file, 'utf8').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*#\[tauri::command/.test(lines[i])) continue;
    // 直前 3 行以内の exempt マーカー (理由コメント付き opt-out)
    const lookback = lines.slice(Math.max(0, i - 3), i).join('\n');
    if (lookback.includes(EXEMPT_MARKER)) continue;
    // attr 行から fn シグネチャの開始 `{` (または `;`) までを連結して戻り値型を見る
    let sig = '';
    let fnName = null;
    for (let j = i + 1; j < Math.min(lines.length, i + 30); j++) {
      sig += lines[j] + '\n';
      if (fnName === null) {
        const m = sig.match(/\bfn\s+([A-Za-z0-9_]+)/);
        if (m) fnName = m[1];
      }
      if (/[{;]\s*$/.test(lines[j]) && fnName !== null) break;
    }
    if (fnName === null) continue; // attr の直後に fn が見つからない変則形は対象外
    const key = `${rel}::${fnName}`;
    if (BASELINE_EXEMPT.has(key)) continue;
    if (!/->[\s\S]*\bCommandResult\s*</.test(sig)) {
      violations.push(`${rel}:${i + 1}: ${fnName}`);
    }
  }
}

if (violations.length > 0) {
  console.error(`CommandResult 検査違反が ${violations.length} 件あります:\n`);
  for (const v of violations) console.error(`  ${v}`);
  console.error(`
#[tauri::command] の戻り値は commands/error.rs の CommandResult<T> に統一してください
(失敗は { code, message } の CommandError として renderer に届きます / Issue #931)。
Option<T> や ok/error 埋め込みの旧流派をコピーしないこと。やむを得ない場合は
直前行に // command-result-exempt: <理由> を書いて opt-out してください。`);
  process.exit(1);
}

console.log('[check-command-result] OK (all #[tauri::command] return CommandResult)');
