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

/// strict gateと同一snapshotのcanonical capability + active rawを返すcrate内helper。
pub(crate) async fn assert_active_project_root_with_raw(
    project_root_slot: &ArcSwapOption<String>,
    project_root_identity_slot: &ArcSwapOption<ProjectRootIdentity>,
    given: &str,
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
    if !identity_recently_verified(&stored_identity) {
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
