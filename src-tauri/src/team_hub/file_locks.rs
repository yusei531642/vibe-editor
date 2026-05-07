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

/// path を正規化: backslash → slash、`./` prefix 除去、連続 slash 圧縮、末尾 slash 除去、trim。
pub fn normalize_path(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    // backslash → forward slash
    let unified: String = trimmed
        .chars()
        .map(|c| if c == '\\' { '/' } else { c })
        .collect();
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
    // 末尾 slash 削除 (root `/` だけは残す)
    while out.len() > 1 && out.ends_with('/') {
        out.pop();
    }
    out
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
        let path = normalize_path(raw);
        if path.is_empty() {
            continue;
        }
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
        let path = normalize_path(raw);
        if path.is_empty() {
            continue;
        }
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
        let path = normalize_path(raw);
        if path.is_empty() {
            continue;
        }
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
        assert_eq!(normalize_path("src/foo.ts"), "src/foo.ts");
        assert_eq!(normalize_path("  src/foo.ts  "), "src/foo.ts");
        assert_eq!(normalize_path(""), "");
        assert_eq!(normalize_path("   "), "");
    }

    #[test]
    fn normalize_path_unifies_separators() {
        assert_eq!(normalize_path(r"src\foo\bar.rs"), "src/foo/bar.rs");
        assert_eq!(normalize_path("src/foo\\bar.rs"), "src/foo/bar.rs");
    }

    #[test]
    fn normalize_path_compresses_double_slashes() {
        assert_eq!(normalize_path("src//foo///bar.rs"), "src/foo/bar.rs");
    }

    #[test]
    fn normalize_path_strips_dot_prefix() {
        assert_eq!(normalize_path("./src/foo.ts"), "src/foo.ts");
    }

    #[test]
    fn normalize_path_strips_trailing_slash() {
        assert_eq!(normalize_path("src/foo/"), "src/foo");
        assert_eq!(normalize_path("src/foo///"), "src/foo");
        // root `/` は残す
        assert_eq!(normalize_path("/"), "/");
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
