//! vibe-team の advisory file locks。Issue #526。
//!
//! 複数 worker が同じファイルを silent overwrite するのを防ぐため、worker が edit 前後で
//! `team_lock_files` / `team_unlock_files` を呼ぶ協調的 (advisory) ロック表を提供する。
//! さらに `team_assign_task(target_paths=[...])` で渡された path に対する競合検知も担う。
//!
//! 設計:
//! - **in-memory のみ**。永続化は本 issue の out-of-scope (再起動でロック clear)。
//! - **advisory** = 取得しなくても hard fail しない。worker が呼ばないと lock されない。
//!   WORKER_TEMPLATE / SKILL.md 側の運用ガイドで補強する想定 (#517 / #519 と同じ思想)。
//! - 競合時は `team_recruit` の lint と同様に **warn 同梱** で続行 (Leader/worker 自身が判断)。
//! - team_id でスコープ。同一 path でも team が違えば独立にロック可能。
//! - path 正規化: backslash → forward slash、`./` prefix 除去、連続 slash 圧縮、末尾 slash 除去。
//!
//! 公開 API (本モジュール):
//! - `FileLock` / `LockConflict` / `LockResult` 型
//! - `normalize_path(raw)` — 正規化ヘルパ
//! - `try_acquire`, `release`, `release_all_for_agent`, `peek`, `list_for_team` —
//!   `HashMap<(team_id, path), FileLock>` を引数に取る純関数。HubState のミューテーション
//!   を伴う部分は呼び出し側 (state.rs の TeamHub method) で wrap する。

use chrono::Utc;
use serde::Serialize;
use std::collections::HashMap;

/// Issue #599 (Tier A-1): 1 path 文字列の最大バイト長。
/// `MAX_LOCK_PATH_LEN` (4 KiB) は IPC 層の payload 上限、こちらは正規化後の論理 path 上限。
/// 1024 byte で repo 内の現実的な深さ (git index も 1 KiB 前後で truncate される) をカバー。
pub const MAX_LOCK_PATH_BYTES: usize = 1024;

/// `normalize_path` で reject される入力理由。Issue #599: traversal / 絶対 path / 制御文字 /
/// 過大長 / 空 path を validator として弾けるようにする。
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileLockError {
    /// path が空 (trim 後)。
    Empty,
    /// path が `MAX_LOCK_PATH_BYTES` を超える。
    TooLong { len: usize, limit: usize },
    /// NUL や ESC などの制御文字 (0x00..=0x1F、tab 含む) を含む。
    /// CRLF や ESC は audit log / Leader terminal 表示の prompt injection に使われ得る。
    ControlChar,
    /// 絶対 path (Unix の `/` 始まり / Windows の `C:\` `\\` `\\?\` 等) — repo-relative のみ許可。
    Absolute,
    /// `..` セグメントを含む — traversal 防止。
    ParentDir,
}

impl std::fmt::Display for FileLockError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FileLockError::Empty => write!(f, "path must not be empty"),
            FileLockError::TooLong { len, limit } => {
                write!(f, "path too long: {len} bytes (limit {limit})")
            }
            FileLockError::ControlChar => {
                write!(f, "path must not contain control characters (0x00..=0x1F)")
            }
            FileLockError::Absolute => write!(
                f,
                "absolute path is not allowed (must be repo-relative; reject Unix '/...', Windows 'C:\\...' / '\\\\...')"
            ),
            FileLockError::ParentDir => {
                write!(f, "parent directory ('..') segments are not allowed")
            }
        }
    }
}

/// Issue #599: team あたり lock 数上限を超えたとき返す詳細。`team_lock_files` で
/// `too_many_locks` ToolError にマップする。
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileLockCapExceeded {
    pub current: usize,
    pub requested: usize,
    pub cap: usize,
}

/// 1 path に対する 1 件のロック情報。
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileLock {
    pub path: String,
    pub team_id: String,
    pub agent_id: String,
    pub role: String,
    /// 取得時刻 (RFC 3339)。
    pub acquired_at: String,
}

/// 競合した path 1 件 (= 既に他 agent が握っているロックの情報)。
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockConflict {
    pub path: String,
    pub holder_agent_id: String,
    pub holder_role: String,
    pub acquired_at: String,
}

/// `try_acquire` の結果。`locked` と `conflicts` は path レベルで partition される
/// (= **partial success** 設計。一部 path が conflict でも残りは locked される)。
/// caller が all-or-nothing を要するなら、`conflicts` が空でない場合に得た `locked` を
/// 手動で `release` し直すこと。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LockResult {
    pub locked: Vec<String>,
    pub conflicts: Vec<LockConflict>,
}

impl LockResult {
    pub fn has_conflicts(&self) -> bool {
        !self.conflicts.is_empty()
    }
}

/// `release` の結果 (unlocked path 配列)。response shape を語彙的に揃えるための型。
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockResult {
    pub unlocked: Vec<String>,
}

/// path を正規化 + バリデーションする。Issue #599 (Tier A-1) で `String` 返しから
/// `Result<String, FileLockError>` に変更。`..` / 絶対 path / 制御文字 / 過大長 / 空 path を
/// 全て reject することで、advisory lock 表に traversal や別 team の path が紛れ込まないようにする。
///
/// 正規化処理: backslash → slash、`./` prefix 除去、連続 slash 圧縮、末尾 slash 除去、trim。
pub fn normalize_path(raw: &str) -> Result<String, FileLockError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(FileLockError::Empty);
    }
    if trimmed.len() > MAX_LOCK_PATH_BYTES {
        return Err(FileLockError::TooLong {
            len: trimmed.len(),
            limit: MAX_LOCK_PATH_BYTES,
        });
    }
    // 制御文字 (NUL / 0x01..=0x1F、tab 含む) — audit log / Leader 端末 inject の改行混入を防ぐ。
    if trimmed.bytes().any(|b| b <= 0x1F || b == 0x7F) {
        return Err(FileLockError::ControlChar);
    }
    // Windows のドライブレター ("C:" / "c:" / "C:\..." / "C:/...") は backslash 統一の前に検出。
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
        return Err(FileLockError::Absolute);
    }
    // UNC / extended-length prefix ("\\\\server\\share" / "\\\\?\\..." / "//server/share") を弾く。
    if trimmed.starts_with(r"\\") || trimmed.starts_with("//") {
        return Err(FileLockError::Absolute);
    }
    // backslash → forward slash
    let unified: String = trimmed
        .chars()
        .map(|c| if c == '\\' { '/' } else { c })
        .collect();
    // Unix 絶対 path (`/etc/passwd`) — UNC / `//` は上で弾いたので、ここは単発 `/` 始まりだけ。
    if unified.starts_with('/') {
        return Err(FileLockError::Absolute);
    }
    // 連続 slash を 1 個に圧縮
    let mut compressed = String::with_capacity(unified.len());
    let mut prev_slash = false;
    for ch in unified.chars() {
        if ch == '/' {
            if !prev_slash {
                compressed.push('/');
                prev_slash = true;
            }
        } else {
            compressed.push(ch);
            prev_slash = false;
        }
    }
    // `./foo` → `foo`
    let mut out = if let Some(stripped) = compressed.strip_prefix("./") {
        stripped.to_string()
    } else {
        compressed
    };
    // 末尾 slash 削除
    while out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    // `..` セグメントを含む path は traversal とみなして reject。
    // 部分文字列ではなくセグメント単位で判定 (例: `..foo` や `foo..bar` は許可)。
    if out.split('/').any(|seg| seg == "..") {
        return Err(FileLockError::ParentDir);
    }
    Ok(out)
}

/// Issue #599 (Tier A-1): `try_acquire` を team-cap 付きで呼ぶ atomic helper。
/// HubState の Mutex 内で「count → cap check → try_acquire」を 1 セッションで完結させ、
/// race による cap 超過 (= 別 agent が同時に push して上限を踏み越える) を防ぐ。
///
/// idempotent な再 lock (= 同一 agent_id が既に持っている path) も `paths.len()` で数えるため、
/// `current + paths.len() > cap` の判定はやや over-conservative だが、cap は DoS 防止のための
/// 概算値なので正確性より単純さ・atomic 性を優先する。
pub fn try_acquire_with_cap(
    map: &mut HashMap<(String, String), FileLock>,
    team_id: &str,
    agent_id: &str,
    role: &str,
    paths: &[String],
    cap: usize,
) -> Result<LockResult, FileLockCapExceeded> {
    let current = map.iter().filter(|((tid, _), _)| tid == team_id).count();
    if current.saturating_add(paths.len()) > cap {
        return Err(FileLockCapExceeded {
            current,
            requested: paths.len(),
            cap,
        });
    }
    Ok(try_acquire(map, team_id, agent_id, role, paths))
}

/// `paths` のうち取得できたものは map に追加し、既に他 agent が保持しているものは
/// `conflicts` に積む。同一 agent_id が再 lock した場合は idempotent (`locked` に積む)。
/// 空文字 path は skip。**partial success**: 一部 path で conflict が出ても残りは locked される。
pub fn try_acquire(
    map: &mut HashMap<(String, String), FileLock>,
    team_id: &str,
    agent_id: &str,
    role: &str,
    paths: &[String],
) -> LockResult {
    let now = Utc::now().to_rfc3339();
    let mut locked = Vec::new();
    let mut conflicts = Vec::new();
    for raw in paths {
        // Issue #599: invalid path (`..` / 絶対 / 制御文字 / 過大長 / 空) は silent skip。
        // 通常 IPC 層 (`team_lock_files`) で先に reject される (= ここに到達しないはず) が、
        // 内部 caller のための defense-in-depth として silent skip する。
        let Ok(path) = normalize_path(raw) else {
            continue;
        };
        let key = (team_id.to_string(), path.clone());
        if let Some(existing) = map.get(&key) {
            if existing.agent_id == agent_id {
                // 自分が既に持っている → idempotent
                locked.push(path);
                continue;
            }
            conflicts.push(LockConflict {
                path: existing.path.clone(),
                holder_agent_id: existing.agent_id.clone(),
                holder_role: existing.role.clone(),
                acquired_at: existing.acquired_at.clone(),
            });
        } else {
            map.insert(
                key,
                FileLock {
                    path: path.clone(),
                    team_id: team_id.to_string(),
                    agent_id: agent_id.to_string(),
                    role: role.to_string(),
                    acquired_at: now.clone(),
                },
            );
            locked.push(path);
        }
    }
    LockResult { locked, conflicts }
}

/// `paths` のうち自分 (`agent_id`) が保持していたものを map から削除し、解放できた path を返す。
/// 他 agent が保持している path は無視 (silent skip — release は宣言的なので過剰削除を避ける)。
pub fn release(
    map: &mut HashMap<(String, String), FileLock>,
    team_id: &str,
    agent_id: &str,
    paths: &[String],
) -> UnlockResult {
    let mut unlocked = Vec::new();
    for raw in paths {
        // Issue #599: invalid path は silent skip (defense-in-depth、IPC で先に reject される)。
        let Ok(path) = normalize_path(raw) else {
            continue;
        };
        let key = (team_id.to_string(), path.clone());
        if let Some(existing) = map.get(&key) {
            if existing.agent_id == agent_id {
                map.remove(&key);
                unlocked.push(path);
            }
        }
    }
    UnlockResult { unlocked }
}

/// `agent_id` が `team_id` 内で保持している全ロックを解放する。
/// `team_dismiss` 等で worker が消えるときの掃除用。返り値は解放数。
pub fn release_all_for_agent(
    map: &mut HashMap<(String, String), FileLock>,
    team_id: &str,
    agent_id: &str,
) -> u32 {
    let mut count: u32 = 0;
    map.retain(|(tid, _path), lock| {
        if tid == team_id && lock.agent_id == agent_id {
            count += 1;
            false
        } else {
            true
        }
    });
    count
}

/// `paths` で指定された path のうち、現在ロックされているものの保持者情報を返す
/// (assign_task の競合検知用、map は read-only)。`agent_id_filter` が `Some` なら
/// その agent 自身が握る lock は除外する (= 他 agent の lock のみ返す)。
pub fn peek(
    map: &HashMap<(String, String), FileLock>,
    team_id: &str,
    agent_id_filter: Option<&str>,
    paths: &[String],
) -> Vec<LockConflict> {
    let mut out = Vec::new();
    for raw in paths {
        // Issue #599: invalid path は silent skip (defense-in-depth、IPC で先に reject される)。
        let Ok(path) = normalize_path(raw) else {
            continue;
        };
        let key = (team_id.to_string(), path);
        if let Some(existing) = map.get(&key) {
            if let Some(self_aid) = agent_id_filter {
                if existing.agent_id == self_aid {
                    continue;
                }
            }
            out.push(LockConflict {
                path: existing.path.clone(),
                holder_agent_id: existing.agent_id.clone(),
                holder_role: existing.role.clone(),
                acquired_at: existing.acquired_at.clone(),
            });
        }
    }
    out
}

/// team_id 内のロック一覧を返す (diagnostics / UI 表示用)。
pub fn list_for_team(
    map: &HashMap<(String, String), FileLock>,
    team_id: &str,
) -> Vec<FileLock> {
    map.iter()
        .filter(|((tid, _), _)| tid == team_id)
        .map(|(_, lock)| lock.clone())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_map() -> HashMap<(String, String), FileLock> {
        HashMap::new()
    }

    #[test]
    fn normalize_path_handles_basic_cases() {
        assert_eq!(normalize_path("src/foo.ts").unwrap(), "src/foo.ts");
        assert_eq!(normalize_path("  src/foo.ts  ").unwrap(), "src/foo.ts");
        // Issue #599: 空 / 空白のみは Empty で reject される。
        assert_eq!(normalize_path(""), Err(FileLockError::Empty));
        assert_eq!(normalize_path("   "), Err(FileLockError::Empty));
    }

    #[test]
    fn normalize_path_unifies_separators() {
        assert_eq!(normalize_path(r"src\foo\bar.rs").unwrap(), "src/foo/bar.rs");
        assert_eq!(normalize_path("src/foo\\bar.rs").unwrap(), "src/foo/bar.rs");
    }

    #[test]
    fn normalize_path_compresses_double_slashes() {
        assert_eq!(normalize_path("src//foo///bar.rs").unwrap(), "src/foo/bar.rs");
    }

    #[test]
    fn normalize_path_strips_dot_prefix() {
        assert_eq!(normalize_path("./src/foo.ts").unwrap(), "src/foo.ts");
    }

    #[test]
    fn normalize_path_strips_trailing_slash() {
        assert_eq!(normalize_path("src/foo/").unwrap(), "src/foo");
        assert_eq!(normalize_path("src/foo///").unwrap(), "src/foo");
        // Issue #599: root `/` は絶対 path として reject される。
        assert_eq!(normalize_path("/"), Err(FileLockError::Absolute));
    }

    /// Issue #599 (Tier A-1): `..` セグメントを含む path は reject される。
    /// セグメント単位での判定なので `..foo` や `foo..bar` (= 単独 `..` ではない) は通る。
    #[test]
    fn normalize_path_rejects_parent_dir_traversal() {
        assert_eq!(
            normalize_path("../etc/passwd"),
            Err(FileLockError::ParentDir)
        );
        assert_eq!(
            normalize_path("../../etc/passwd"),
            Err(FileLockError::ParentDir)
        );
        assert_eq!(
            normalize_path("src/../../etc/passwd"),
            Err(FileLockError::ParentDir)
        );
        assert_eq!(
            normalize_path(r"..\..\windows\system32"),
            Err(FileLockError::ParentDir)
        );
        assert_eq!(
            normalize_path("src/..//etc"),
            Err(FileLockError::ParentDir)
        );
        // Issue #599: traversal で **ない** パターン (= `..` を部分文字列にしか含まない) は通る。
        assert_eq!(normalize_path("src/foo..bar.rs").unwrap(), "src/foo..bar.rs");
        assert_eq!(normalize_path("..foo/bar").unwrap(), "..foo/bar");
    }

    /// Issue #599: 絶対 path (Unix の `/` 始まり / Windows のドライブレター / UNC) は reject。
    #[test]
    fn normalize_path_rejects_absolute_paths() {
        // Unix
        assert_eq!(
            normalize_path("/etc/passwd"),
            Err(FileLockError::Absolute)
        );
        assert_eq!(normalize_path("/"), Err(FileLockError::Absolute));
        // Windows drive letter (大文字 / 小文字 / forward / backward)
        assert_eq!(
            normalize_path(r"C:\Windows\System32"),
            Err(FileLockError::Absolute)
        );
        assert_eq!(
            normalize_path("C:/Windows/System32"),
            Err(FileLockError::Absolute)
        );
        assert_eq!(
            normalize_path("d:/users/yusei"),
            Err(FileLockError::Absolute)
        );
        assert_eq!(normalize_path("C:"), Err(FileLockError::Absolute));
        // UNC / extended-length
        assert_eq!(
            normalize_path(r"\\server\share\foo"),
            Err(FileLockError::Absolute)
        );
        assert_eq!(
            normalize_path(r"\\?\C:\foo"),
            Err(FileLockError::Absolute)
        );
        assert_eq!(
            normalize_path("//server/share/foo"),
            Err(FileLockError::Absolute)
        );
    }

    /// Issue #599: 制御文字 (NUL / 0x01..=0x1F、tab、DEL=0x7F) を含む path は reject。
    /// 改行や ESC が path に紛れ込むと audit log や Leader 端末 inject の format を破壊するため。
    #[test]
    fn normalize_path_rejects_control_characters() {
        assert_eq!(
            normalize_path("src/foo\nbar.rs"),
            Err(FileLockError::ControlChar)
        );
        assert_eq!(
            normalize_path("src/foo\rbar.rs"),
            Err(FileLockError::ControlChar)
        );
        assert_eq!(
            normalize_path("src/foo\x1b[31mred.rs"),
            Err(FileLockError::ControlChar)
        );
        assert_eq!(
            normalize_path("src/foo\0bar.rs"),
            Err(FileLockError::ControlChar)
        );
        assert_eq!(
            normalize_path("src/foo\tbar.rs"),
            Err(FileLockError::ControlChar)
        );
        assert_eq!(
            normalize_path("src/foo\x7fbar.rs"),
            Err(FileLockError::ControlChar)
        );
    }

    /// Issue #599: `MAX_LOCK_PATH_BYTES` (1024) 超は reject。
    #[test]
    fn normalize_path_rejects_too_long() {
        let just_ok = "a".repeat(MAX_LOCK_PATH_BYTES);
        assert!(normalize_path(&just_ok).is_ok());

        let over = "a".repeat(MAX_LOCK_PATH_BYTES + 1);
        let err = normalize_path(&over).unwrap_err();
        assert!(matches!(err, FileLockError::TooLong { .. }));
    }

    /// Issue #599 (Tier A-1): `try_acquire_with_cap` は team あたり lock 数上限を atomic に enforce。
    /// 既存件数 + 新規要求 が cap を超えると `FileLockCapExceeded` で reject される。
    /// idempotent な再 lock (= paths.len() に含まれるが新規 insert はゼロ) でも reject 側で数える
    /// (over-conservative だが atomic 性を優先する設計)。
    #[test]
    fn try_acquire_with_cap_rejects_over_limit() {
        let mut map = make_map();
        let cap = 3;
        // 3 件を pre-insert
        try_acquire_with_cap(
            &mut map,
            "team-1",
            "vc-alice",
            "programmer",
            &[
                "src/a.rs".to_string(),
                "src/b.rs".to_string(),
                "src/c.rs".to_string(),
            ],
            cap,
        )
        .expect("3/3 should fit");

        // 4 件目を追加 → cap 超過で reject。
        let err = try_acquire_with_cap(
            &mut map,
            "team-1",
            "vc-bob",
            "reviewer",
            &["src/d.rs".to_string()],
            cap,
        )
        .unwrap_err();
        assert_eq!(err.current, 3);
        assert_eq!(err.requested, 1);
        assert_eq!(err.cap, cap);
        // map は変化しない (atomic)
        assert_eq!(map.len(), 3);
    }

    /// Issue #599: cap は team scope。別 team の lock は count されない。
    #[test]
    fn try_acquire_with_cap_is_team_scoped() {
        let mut map = make_map();
        // team-2 に 5 件入れても team-1 の cap=3 には影響しない
        try_acquire_with_cap(
            &mut map,
            "team-2",
            "vc-other",
            "programmer",
            &[
                "src/a.rs".to_string(),
                "src/b.rs".to_string(),
                "src/c.rs".to_string(),
                "src/d.rs".to_string(),
                "src/e.rs".to_string(),
            ],
            10,
        )
        .expect("team-2 fits in cap=10");
        let result = try_acquire_with_cap(
            &mut map,
            "team-1",
            "vc-alice",
            "programmer",
            &[
                "src/a.rs".to_string(),
                "src/b.rs".to_string(),
                "src/c.rs".to_string(),
            ],
            3,
        )
        .expect("team-1 fits in its own cap=3");
        assert_eq!(result.locked.len(), 3);
        assert_eq!(map.len(), 8);
    }

    #[test]
    fn try_acquire_basic() {
        let mut map = make_map();
        let result = try_acquire(
            &mut map,
            "team-1",
            "vc-alice",
            "programmer",
            &["src/foo.rs".to_string(), "src/bar.rs".to_string()],
        );
        assert_eq!(result.locked, vec!["src/foo.rs", "src/bar.rs"]);
        assert!(result.conflicts.is_empty());
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn try_acquire_idempotent_for_same_agent() {
        let mut map = make_map();
        try_acquire(&mut map, "team-1", "vc-alice", "programmer", &["src/foo.rs".to_string()]);
        let result =
            try_acquire(&mut map, "team-1", "vc-alice", "programmer", &["src/foo.rs".to_string()]);
        assert_eq!(result.locked, vec!["src/foo.rs"]);
        assert!(result.conflicts.is_empty());
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn try_acquire_conflict_partitions_acquired_and_conflicts() {
        let mut map = make_map();
        // alice が foo.rs を握る
        try_acquire(&mut map, "team-1", "vc-alice", "programmer", &["src/foo.rs".to_string()]);
        // bob が [foo.rs, bar.rs] を取りに来る → foo は conflict、bar は acquire
        let result = try_acquire(
            &mut map,
            "team-1",
            "vc-bob",
            "reviewer",
            &["src/foo.rs".to_string(), "src/bar.rs".to_string()],
        );
        assert_eq!(result.locked, vec!["src/bar.rs"]);
        assert_eq!(result.conflicts.len(), 1);
        assert_eq!(result.conflicts[0].path, "src/foo.rs");
        assert_eq!(result.conflicts[0].holder_agent_id, "vc-alice");
        assert!(result.has_conflicts());
    }

    #[test]
    fn try_acquire_normalizes_paths() {
        let mut map = make_map();
        // 同一 path を異なる表記で渡す → 1 件として扱われる
        try_acquire(
            &mut map,
            "team-1",
            "vc-alice",
            "programmer",
            &[r"src\foo.rs".to_string(), "./src/foo.rs".to_string(), "src//foo.rs".to_string()],
        );
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn try_acquire_skips_empty_paths() {
        let mut map = make_map();
        let result = try_acquire(
            &mut map,
            "team-1",
            "vc-alice",
            "programmer",
            &["".to_string(), "  ".to_string(), "src/foo.rs".to_string()],
        );
        assert_eq!(result.locked, vec!["src/foo.rs"]);
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn try_acquire_team_scoped() {
        let mut map = make_map();
        // 同一 path でも team が違えば独立に取得できる
        try_acquire(&mut map, "team-1", "vc-alice", "programmer", &["src/foo.rs".to_string()]);
        let result =
            try_acquire(&mut map, "team-2", "vc-bob", "programmer", &["src/foo.rs".to_string()]);
        assert_eq!(result.locked, vec!["src/foo.rs"]);
        assert!(result.conflicts.is_empty());
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn release_returns_only_self_owned_paths() {
        let mut map = make_map();
        try_acquire(
            &mut map,
            "team-1",
            "vc-alice",
            "programmer",
            &["src/foo.rs".to_string(), "src/bar.rs".to_string()],
        );
        try_acquire(&mut map, "team-1", "vc-bob", "reviewer", &["src/baz.rs".to_string()]);
        // alice が [foo.rs (自分), baz.rs (bob)] を解放しようとしても baz.rs は無視
        let result = release(
            &mut map,
            "team-1",
            "vc-alice",
            &["src/foo.rs".to_string(), "src/baz.rs".to_string()],
        );
        assert_eq!(result.unlocked, vec!["src/foo.rs"]);
        assert_eq!(map.len(), 2); // bar (alice) + baz (bob) が残る
    }

    #[test]
    fn release_normalizes_paths() {
        let mut map = make_map();
        try_acquire(&mut map, "team-1", "vc-alice", "programmer", &["src/foo.rs".to_string()]);
        let result =
            release(&mut map, "team-1", "vc-alice", &[r"src\foo.rs".to_string()]);
        assert_eq!(result.unlocked, vec!["src/foo.rs"]);
        assert!(map.is_empty());
    }

    #[test]
    fn release_all_for_agent_clears_only_self() {
        let mut map = make_map();
        try_acquire(
            &mut map,
            "team-1",
            "vc-alice",
            "programmer",
            &["src/foo.rs".to_string(), "src/bar.rs".to_string()],
        );
        try_acquire(&mut map, "team-1", "vc-bob", "reviewer", &["src/baz.rs".to_string()]);
        let count = release_all_for_agent(&mut map, "team-1", "vc-alice");
        assert_eq!(count, 2);
        assert_eq!(map.len(), 1);
        assert!(map.values().any(|l| l.agent_id == "vc-bob"));
    }

    #[test]
    fn release_all_for_agent_team_scoped() {
        let mut map = make_map();
        try_acquire(&mut map, "team-1", "vc-alice", "programmer", &["src/foo.rs".to_string()]);
        try_acquire(&mut map, "team-2", "vc-alice", "programmer", &["src/bar.rs".to_string()]);
        // team-1 の alice の lock だけ解放する (team-2 のは残る)
        let count = release_all_for_agent(&mut map, "team-1", "vc-alice");
        assert_eq!(count, 1);
        assert_eq!(map.len(), 1);
    }

    #[test]
    fn peek_returns_holders_for_other_agents() {
        let mut map = make_map();
        try_acquire(&mut map, "team-1", "vc-alice", "programmer", &["src/foo.rs".to_string()]);
        // bob が peek (alice の lock を見る、自分宛は除外)
        let conflicts = peek(
            &map,
            "team-1",
            Some("vc-bob"),
            &["src/foo.rs".to_string(), "src/bar.rs".to_string()],
        );
        assert_eq!(conflicts.len(), 1);
        assert_eq!(conflicts[0].holder_agent_id, "vc-alice");
    }

    #[test]
    fn peek_excludes_self_when_filter_set() {
        let mut map = make_map();
        try_acquire(&mut map, "team-1", "vc-alice", "programmer", &["src/foo.rs".to_string()]);
        // alice が peek (自分の lock は conflict ではないので除外される)
        let conflicts = peek(
            &map,
            "team-1",
            Some("vc-alice"),
            &["src/foo.rs".to_string()],
        );
        assert!(conflicts.is_empty());
    }

    #[test]
    fn peek_includes_all_when_filter_none() {
        let mut map = make_map();
        try_acquire(&mut map, "team-1", "vc-alice", "programmer", &["src/foo.rs".to_string()]);
        // filter=None → 自分も他人もなく全 holder を返す
        let conflicts = peek(&map, "team-1", None, &["src/foo.rs".to_string()]);
        assert_eq!(conflicts.len(), 1);
    }

    #[test]
    fn list_for_team_returns_only_team_locks() {
        let mut map = make_map();
        try_acquire(&mut map, "team-1", "vc-alice", "programmer", &["src/foo.rs".to_string()]);
        try_acquire(&mut map, "team-2", "vc-bob", "reviewer", &["src/bar.rs".to_string()]);
        let team1_locks = list_for_team(&map, "team-1");
        assert_eq!(team1_locks.len(), 1);
        assert_eq!(team1_locks[0].path, "src/foo.rs");
    }
}
