//! strict active-project authorization capability。

use super::{clamp_for_log, ProjectRoot};
use crate::commands::error::{CommandError, CommandResult};
use crate::commands::project_authority::ProjectRootIdentity;
use crate::state::{current_project_root, current_project_root_identity};
use arc_swap::ArcSwapOption;

/// active projectとの照合に成功した同一snapshotを表すcapability。
/// requested rawは保持せず、Claude directory互換用のactive rawだけを保持する。
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AuthorizedActiveProjectRoot {
    canonical: ProjectRoot,
    active_raw: String,
    approved_identity: ProjectRootIdentity,
}

impl AuthorizedActiveProjectRoot {
    /// gate時点のcanonical identityとactive raw表記を、そのまま後続readerへ渡す。
    ///
    /// readerはこの値を再canonicalizeせず、snapshotの比較keyだけでstorageを選別する。
    /// これによりgate後のsymlink retargetを新しいproject identityとして採用しない。
    pub(crate) fn into_parts(self) -> (ProjectRoot, String) {
        (self.canonical, self.active_raw)
    }

    /// 認可時に採ったactive raw表記の、I/Oなし比較keyを返す。
    ///
    /// rawを再canonicalizeすると、gate後のsymlink retargetを新しいidentityとして採用して
    /// しまう。既存storageがraw project_rootをkeyに持つ場合だけ、このsnapshot keyを使う。
    /// gate が照合に用いた native approval identity snapshot を返す。
    ///
    /// これは picker 承認時に記録された identity (slot 値) であり、gate 後の filesystem
    /// 変化を含まない。storage が entry 単位の identity 照合 (Issue #1192) を行うときの
    /// 比較基準にする。
    pub(crate) fn approved_identity(&self) -> &ProjectRootIdentity {
        &self.approved_identity
    }

    pub(crate) fn active_raw_key(&self) -> String {
        let normalized = self.active_raw.replace('\\', "/");
        let stripped = normalized.trim_end_matches('/');
        if cfg!(windows) {
            stripped.to_lowercase()
        } else {
            stripped.to_string()
        }
    }
}

/// renderer由来のrootがAppState active rootとcanonical一致することを検証する。
pub async fn assert_active_project_root(
    project_root_slot: &ArcSwapOption<String>,
    project_root_identity_slot: &ArcSwapOption<ProjectRootIdentity>,
    given: &str,
) -> CommandResult<ProjectRoot> {
    assert_active_project_root_with_raw(project_root_slot, project_root_identity_slot, given)
        .await
        .map(|authorized| authorized.canonical)
}

/// identity 再照合キャッシュの利用可否。PTY / MCP の起動境界 (Issue #1200) は必ず
/// `Fresh` を使い、check-to-use 間の directory 置換を TTL 内でも見逃さない。
#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum RecheckPolicy {
    CachedTtl,
    Fresh,
}

/// strict gateと同一snapshotのcanonical capability + active rawを返すcrate内helper。
pub(crate) async fn assert_active_project_root_with_raw(
    project_root_slot: &ArcSwapOption<String>,
    project_root_identity_slot: &ArcSwapOption<ProjectRootIdentity>,
    given: &str,
) -> CommandResult<AuthorizedActiveProjectRoot> {
    assert_active_project_root_policy(
        project_root_slot,
        project_root_identity_slot,
        given,
        RecheckPolicy::CachedTtl,
    )
    .await
}

/// 起動境界用: identity 再照合の TTL キャッシュを使わず必ず platform identity を取り直す。
pub async fn assert_active_project_root_fresh(
    project_root_slot: &ArcSwapOption<String>,
    project_root_identity_slot: &ArcSwapOption<ProjectRootIdentity>,
    given: &str,
) -> CommandResult<ProjectRoot> {
    assert_active_project_root_policy(
        project_root_slot,
        project_root_identity_slot,
        given,
        RecheckPolicy::Fresh,
    )
    .await
    .map(|authorized| authorized.canonical)
}

pub(crate) async fn assert_active_project_root_policy(
    project_root_slot: &ArcSwapOption<String>,
    project_root_identity_slot: &ArcSwapOption<ProjectRootIdentity>,
    given: &str,
    policy: RecheckPolicy,
) -> CommandResult<AuthorizedActiveProjectRoot> {
    let trimmed = given.trim();
    if trimmed.is_empty() {
        tracing::warn!(
            given = %clamp_for_log(given),
            "[authz] assert_active_project_root rejected: empty project_root"
        );
        return Err(CommandError::authz("project_root is empty"));
    }

    let active = current_project_root(project_root_slot).unwrap_or_default();
    if active.trim().is_empty() {
        tracing::warn!(
            given = %clamp_for_log(given),
            "[authz] assert_active_project_root rejected: no active project_root configured"
        );
        return Err(CommandError::authz("no active project_root configured"));
    }

    // requestedとactiveは独立なのでasync canonicalizeを並列実行する。
    let (req_res, active_res) = tokio::join!(
        tokio::fs::canonicalize(trimmed),
        tokio::fs::canonicalize(active.trim())
    );
    let req_canon = match req_res {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!(
                given = %clamp_for_log(given),
                error = %error,
                "[authz] assert_active_project_root rejected: canonicalize requested project_root failed"
            );
            return Err(CommandError::authz(format!(
                "canonicalize requested project_root failed: {error}"
            )));
        }
    };
    let active_canon = match active_res {
        Ok(path) => path,
        Err(error) => {
            tracing::warn!(
                active = %clamp_for_log(&active),
                error = %error,
                "[authz] assert_active_project_root rejected: canonicalize active project_root failed"
            );
            return Err(CommandError::authz(format!(
                "canonicalize active project_root failed: {error}"
            )));
        }
    };

    if req_canon != active_canon {
        tracing::warn!(
            requested = %clamp_for_log(&req_canon.to_string_lossy()),
            active = %clamp_for_log(&active_canon.to_string_lossy()),
            "[authz] assert_active_project_root rejected: project_root mismatch"
        );
        return Err(CommandError::authz(
            "project_root does not match active project",
        ));
    }

    let Some(stored_identity) = current_project_root_identity(project_root_identity_slot) else {
        tracing::warn!(
            active = %clamp_for_log(&active_canon.to_string_lossy()),
            "[authz] assert_active_project_root rejected: active root has no native identity"
        );
        return Err(CommandError::authz(
            "active project root has no native authority identity",
        ));
    };
    if policy == RecheckPolicy::Fresh || !identity_recently_verified(&stored_identity) {
        let observed_identity =
            crate::commands::project_authority::capture_identity(&active_canon).await?;
        if observed_identity != stored_identity {
            tracing::warn!(
                active = %clamp_for_log(&active_canon.to_string_lossy()),
                "[authz] assert_active_project_root rejected: active root identity changed"
            );
            return Err(CommandError::authz(
                "active project root identity no longer matches its native approval",
            ));
        }
        record_identity_verified(&stored_identity);
    }

    Ok(AuthorizedActiveProjectRoot {
        canonical: ProjectRoot::from_canonical(active_canon),
        active_raw: active,
        approved_identity: stored_identity,
    })
}

/// PTY spawn 直前の cwd 再検証 (Issue #1200)。
///
/// resume が返した canonical cwd と実際の spawn の間に、同一 path の directory が別 project
/// へ置換される check-to-use gap を塞ぐ。cwd が active root / 承認済み workspace root と
/// 同一 directory を指す場合に限り、TTL キャッシュを使わず platform identity を取り直して
/// native approval と照合し、不一致なら起動を拒否する (fail-closed)。project 外 cwd
/// (home fallback 等) と project 未選択時は従来どおり対象外。
pub async fn assert_spawn_cwd_identity(
    project_root_slot: &ArcSwapOption<String>,
    project_root_identity_slot: &ArcSwapOption<ProjectRootIdentity>,
    cwd: &str,
) -> CommandResult<Option<ProjectRootIdentity>> {
    let cwd_canon = match tokio::fs::canonicalize(cwd.trim()).await {
        Ok(path) => path,
        Err(error) => {
            // resolve_valid_cwd 通過後に消えた = 置換・削除の最中。推測せず fail-closed。
            tracing::warn!(
                cwd = %clamp_for_log(cwd),
                error = %error,
                "[authz] spawn cwd rejected: canonicalize failed after validation"
            );
            return Err(CommandError::authz(
                "spawn cwd disappeared while being verified",
            ));
        }
    };
    let cwd_key = crate::commands::project_identity::canonical_root_key(&cwd_canon);

    let active_root = current_project_root(project_root_slot).unwrap_or_default();
    if !active_root.trim().is_empty() && active_root == cwd_key {
        // active root と同一 directory: native approval identity と fresh に照合する。
        let Some(stored) = current_project_root_identity(project_root_identity_slot) else {
            return Err(CommandError::authz(
                "active project root has no native authority identity",
            ));
        };
        let observed =
            crate::commands::project_authority::capture_identity(&cwd_canon).await?;
        if observed != stored {
            tracing::warn!(
                cwd = %clamp_for_log(&cwd_key),
                "[authz] spawn cwd rejected: active root identity changed before spawn"
            );
            return Err(CommandError::authz(
                "spawn cwd identity no longer matches its native approval",
            ));
        }
        record_identity_verified(&stored);
        return Ok(Some(stored));
    }

    if let Some(known) =
        crate::commands::project_authority::workspace_identity_for(&cwd_key).await
    {
        let observed =
            crate::commands::project_authority::capture_identity(&cwd_canon).await?;
        if observed != known {
            tracing::warn!(
                cwd = %clamp_for_log(&cwd_key),
                "[authz] spawn cwd rejected: workspace root identity changed before spawn"
            );
            return Err(CommandError::authz(
                "spawn cwd identity no longer matches its workspace approval",
            ));
        }
        return Ok(Some(known));
    }

    // project 管理外の cwd は #1200 の対象外 (従来挙動を維持)。
    Ok(None)
}

/// identity 再照合 (blocking canonicalize×2 + platform file id×2) の短TTLキャッシュ。
///
/// `files_list` / `git_status` 等の高頻度IPCが毎回 blocking I/O を踏むと、低速ストレージで
/// レイテンシが積み上がる (PR #1202 review)。直近で native identity 一致を確認済みの
/// active root に限り TTL 内は再照合を省略する。TTL 内の directory 置換検知は次の expiry
/// 後の照合まで遅延するが、canonical path 一致 (上段) は毎回検証され、grant の追加は
/// 発生しない。root 切替時は `invalidate_identity_recheck` で即座に破棄する。
const IDENTITY_RECHECK_TTL: std::time::Duration = std::time::Duration::from_secs(2);

static IDENTITY_RECHECK_CACHE: std::sync::Mutex<
    Option<(ProjectRootIdentity, std::time::Instant)>,
> = std::sync::Mutex::new(None);

fn identity_recently_verified(identity: &ProjectRootIdentity) -> bool {
    let cache = IDENTITY_RECHECK_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    matches!(
        &*cache,
        Some((cached, verified_at))
            if cached == identity && verified_at.elapsed() < IDENTITY_RECHECK_TTL
    )
}

fn record_identity_verified(identity: &ProjectRootIdentity) {
    *IDENTITY_RECHECK_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) =
        Some((identity.clone(), std::time::Instant::now()));
}

/// active root の activate / clear 時にキャッシュを即時破棄する (state.rs から呼ぶ)。
pub fn invalidate_identity_recheck() {
    *IDENTITY_RECHECK_CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

#[cfg(test)]
mod recheck_cache_tests {
    use super::*;

    fn identity(root: &str, file_id: &str) -> ProjectRootIdentity {
        ProjectRootIdentity {
            version: 1,
            canonical_root: root.to_string(),
            platform_file_id: file_id.to_string(),
        }
    }

    #[test]
    fn cache_hits_only_for_identical_identity_and_clears_on_invalidate() {
        let current = identity("/tmp/project", "unix:1:100");
        let other = identity("/tmp/project", "unix:1:999");
        invalidate_identity_recheck();
        assert!(!identity_recently_verified(&current));
        record_identity_verified(&current);
        assert!(identity_recently_verified(&current));
        // 同一pathでも filesystem identity が異なる (= 置換された) 場合は再照合へ回す。
        assert!(!identity_recently_verified(&other));
        invalidate_identity_recheck();
        assert!(!identity_recently_verified(&current));
    }
}
