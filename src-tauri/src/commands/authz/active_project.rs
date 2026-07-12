//! strict active-project authorization capability。

use super::{clamp_for_log, ProjectRoot};
use crate::commands::error::{CommandError, CommandResult};
use crate::state::current_project_root;
use arc_swap::ArcSwapOption;

/// active projectとの照合に成功した同一snapshotを表すcapability。
/// requested rawは保持せず、Claude directory互換用のactive rawだけを保持する。
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AuthorizedActiveProjectRoot {
    canonical: ProjectRoot,
    active_raw: String,
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
    given: &str,
) -> CommandResult<ProjectRoot> {
    assert_active_project_root_with_raw(project_root_slot, given)
        .await
        .map(|authorized| authorized.canonical)
}

/// strict gateと同一snapshotのcanonical capability + active rawを返すcrate内helper。
pub(crate) async fn assert_active_project_root_with_raw(
    project_root_slot: &ArcSwapOption<String>,
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

    Ok(AuthorizedActiveProjectRoot {
        canonical: ProjectRoot::from_canonical(active_canon),
        active_raw: active,
    })
}
