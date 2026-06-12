//! Issue #935: タスク status のドメイン値 SSOT。
//!
//! 従来は許容値リスト・alias 正規化・open/done 判定が消費側ごとにコピーされて
//! 食い違っていた (update_task 3 語 / team_state 5 語 / report 4 語 / shared.ts の
//! `| string` union)。本 module を唯一の定義源とし、受信境界では `TaskStatus::parse`
//! で正規化、判定は `is_done` / `is_open` メソッド経由のみとする。
//!
//! wire / 永続化フォーマットは従来どおり文字列のまま (canonical な snake_case を
//! `as_str()` で書く)。永続化済みの legacy alias ("completed" / "complete" /
//! "canceled") は parse 側で吸収する。

/// タスクの状態。shared.ts の `TeamTaskStatus` union と同期。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Pending,
    InProgress,
    Done,
    Blocked,
    NeedsInput,
    Failed,
    Cancelled,
}

impl TaskStatus {
    /// canonical 文字列。永続化・IPC への書き込みには必ずこれを使う。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Done => "done",
            Self::Blocked => "blocked",
            Self::NeedsInput => "needs_input",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    /// 受信境界・永続化読込用 parse。大文字小文字を無視し、legacy alias
    /// ("completed"/"complete" → Done, "canceled" → Cancelled) をここ 1 箇所で正規化する。
    /// 不明値は None (受信境界では構造化エラーに、永続化読込では従来互換の挙動に倒す)。
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "pending" => Some(Self::Pending),
            "in_progress" => Some(Self::InProgress),
            "done" | "completed" | "complete" => Some(Self::Done),
            "blocked" => Some(Self::Blocked),
            "needs_input" => Some(Self::NeedsInput),
            "failed" => Some(Self::Failed),
            "cancelled" | "canceled" => Some(Self::Cancelled),
            _ => None,
        }
    }

    /// done_evidence 検証などの「完了扱い」判定。
    pub fn is_done(self) -> bool {
        matches!(self, Self::Done)
    }

    /// open = まだ作業対象 (pending_tasks に出すべき)。Done / Cancelled 以外はすべて open
    /// (Blocked / NeedsInput / Failed は人間や Leader の介入待ちであり「閉じた」わけではない)。
    pub fn is_open(self) -> bool {
        !matches!(self, Self::Done | Self::Cancelled)
    }

    /// エラーメッセージ・JSON schema 用の canonical 許容値一覧。
    pub const fn allowed_values() -> &'static [&'static str] {
        &[
            "pending",
            "in_progress",
            "done",
            "blocked",
            "needs_input",
            "failed",
            "cancelled",
        ]
    }
}

/// 永続化済みの生 status 文字列に対する open 判定。
/// 不明値 (古いデータ / 手書き編集) は従来挙動どおり open 扱いに倒す
/// (勝手に closed 扱いにしてタスクを見失うより安全)。
pub fn is_open_status_str(raw: &str) -> bool {
    TaskStatus::parse(raw).map(TaskStatus::is_open).unwrap_or(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_canonical_values() {
        for &s in TaskStatus::allowed_values() {
            let parsed = TaskStatus::parse(s).expect("canonical value must parse");
            assert_eq!(parsed.as_str(), s, "as_str must roundtrip canonical value");
        }
    }

    #[test]
    fn normalizes_legacy_aliases() {
        assert_eq!(TaskStatus::parse("completed"), Some(TaskStatus::Done));
        assert_eq!(TaskStatus::parse("complete"), Some(TaskStatus::Done));
        assert_eq!(TaskStatus::parse("canceled"), Some(TaskStatus::Cancelled));
        assert_eq!(TaskStatus::parse(" DONE "), Some(TaskStatus::Done));
        assert_eq!(TaskStatus::parse("In_Progress"), Some(TaskStatus::InProgress));
    }

    #[test]
    fn rejects_unknown_values() {
        assert_eq!(TaskStatus::parse(""), None);
        assert_eq!(TaskStatus::parse("wip"), None);
        assert_eq!(TaskStatus::parse("done!"), None);
    }

    #[test]
    fn done_and_open_judgments() {
        assert!(TaskStatus::Done.is_done());
        assert!(!TaskStatus::Blocked.is_done());
        assert!(!TaskStatus::Done.is_open());
        assert!(!TaskStatus::Cancelled.is_open());
        for st in [
            TaskStatus::Pending,
            TaskStatus::InProgress,
            TaskStatus::Blocked,
            TaskStatus::NeedsInput,
            TaskStatus::Failed,
        ] {
            assert!(st.is_open(), "{st:?} must stay open");
        }
    }

    #[test]
    fn raw_string_open_judgment_keeps_legacy_fallback() {
        assert!(!is_open_status_str("completed"));
        assert!(!is_open_status_str("Canceled"));
        assert!(is_open_status_str("blocked"));
        // 不明値は open 扱い (タスクを見失わない)
        assert!(is_open_status_str("mystery-status"));
        assert!(is_open_status_str(""));
    }
}
