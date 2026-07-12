//! Issue #600 (Tier A-2): cross-project leak を防ぐための authorization helper。
//!
//! 背景: `team_state_read` (#600) / `team_diagnostics_read` (#601 / A-3) /
//! `handoffs_*` (#609 / A-8) など複数 IPC が renderer 由来の `project_root` を
//! 引数で受け取り、その path を base64 encode して `~/.vibe-editor/team-state/...`
//! 配下のファイルを読みに行く。`AppState` の active project_root と一致するか
//! 検証していないため、同じ user の別プロジェクトの team-state を任意に閲覧できる
//! cross-project leak が成立していた。
//!
//! 本 module は `app_install_vibe_team_skill` (#191 で実装済み) と同じ手順
//! (active project_root を読む → `canonicalize` 両者比較) を `assert_active_project_root`
//! 1 関数に共通化し、A-2 / A-3 / A-8 で同じ防御を横展開できるようにする。
//!
//! Issue #739: active project_root の保持を `std::sync::Mutex<Option<String>>` から
//! lock-free な `ArcSwapOption<String>` へ移したため、本 helper も `ArcSwapOption` を
//! 受け取る形に追従する (deadlock 経路の構造的排除)。

use std::path::{Path, PathBuf};

use arc_swap::ArcSwapOption;

use crate::commands::error::{CommandError, CommandResult};
use crate::state::current_project_root;
use crate::team_hub::TeamHub;

mod active_project;
pub use active_project::assert_active_project_root;
pub(crate) use active_project::{assert_active_project_root_with_raw, AuthorizedActiveProjectRoot};

/// canonicalize 済み、かつ AppState の active project_root あるいは許可済み workspace folder と
/// 照合済みの project root。FS helper はこの型を要求することで、renderer 由来の生文字列が
/// authz gate を通らずにファイル操作へ届く経路を型で塞ぐ。
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectRoot {
    canonical: PathBuf,
    display: String,
}

impl ProjectRoot {
    fn from_canonical(canonical: PathBuf) -> Self {
        let display = canonical.to_string_lossy().into_owned();
        Self { canonical, display }
    }

    pub fn as_path(&self) -> &Path {
        &self.canonical
    }

    pub fn as_str(&self) -> &str {
        &self.display
    }

    /// gate時に確定したcanonical pathからI/Oなしで比較keyを作る。
    /// capability発行後にsymlinkがretargetされてもidentityを再解決しない。
    pub(crate) fn comparison_key(&self) -> String {
        let normalized = self.display.replace('\\', "/");
        let stripped = normalized.trim_end_matches('/');
        if cfg!(windows) {
            stripped.to_lowercase()
        } else {
            stripped.to_string()
        }
    }

    #[cfg(test)]
    pub(crate) fn assume_canonical_for_test(path: PathBuf) -> Self {
        Self::from_canonical(path)
    }
}

impl AsRef<Path> for ProjectRoot {
    fn as_ref(&self) -> &Path {
        self.as_path()
    }
}

/// 監査ログに raw path を出すときの clamp (制御文字を `?` に置換 + 240 文字で truncate)。
/// renderer 由来の project_root に改行や ESC が混じっていても tracing 行を破壊しないようにする。
fn clamp_for_log(raw: &str) -> String {
    raw.chars()
        .take(240)
        .map(|c| if c.is_control() { '?' } else { c })
        .collect()
}

/// 監査ログ用に team_id を clamp する (制御文字 `?` 置換 + 96 文字 truncate)。
/// `team_id` 自体は ASCII 系の short string が想定だが、renderer から来る入力は信用しない。
fn clamp_team_id_for_log(raw: &str) -> String {
    raw.chars()
        .take(96)
        .map(|c| if c.is_control() { '?' } else { c })
        .collect()
}

/// Issue #954 / #963: ファイル系 IPC (`files_*`) 用のゲート。
///
/// `assert_active_project_root` は active project との厳格一致だが、ファイルツリーは
/// multi-root workspace (native authority ledger, Issue #1193) で active 以外の追加
/// ルートも正当に列挙・閲覧・編集するため、厳格一致だとこの機能が壊れる
/// (#954 で read 側、#963 で write 側に適用)。本 helper は「active project root
/// **または** native picker由来のworkspace grant のいずれか」に
/// canonicalize 一致する場合のみ許可する。
///
/// - settings.workspaceFolders は renderer が更新できる表示用設定であり、認可根拠にしない。
/// - ledgerのgrantはcanonical pathだけでなくfilesystem identityも再照合する。
/// - active が未設定 (起動直後) でも workspaceFolders 一致なら許可する (起動時の
///   追加ルート列挙を transient reject しない)。
pub async fn assert_readable_project_root(
    project_root_slot: &ArcSwapOption<String>,
    project_root_identity_slot: &ArcSwapOption<
        crate::commands::project_authority::ProjectRootIdentity,
    >,
    given: &str,
) -> CommandResult<ProjectRoot> {
    let trimmed = given.trim();
    if trimmed.is_empty() {
        tracing::warn!(
            given = %clamp_for_log(given),
            "[authz] assert_readable_project_root rejected: empty project_root"
        );
        return Err(CommandError::authz("project_root is empty"));
    }
    let req_canon = match tokio::fs::canonicalize(trimmed).await {
        Ok(p) => p,
        Err(e) => {
            tracing::warn!(
                given = %clamp_for_log(given),
                error = %e,
                "[authz] assert_readable_project_root rejected: canonicalize requested project_root failed"
            );
            return Err(CommandError::authz(format!(
                "canonicalize requested project_root failed: {e}"
            )));
        }
    };

    // 1. active project root と一致するか。active stateは#1193のprivate activation helper
    // だけが更新し、rendererから生pathを書き込めるIPCは存在しない。
    let active = current_project_root(project_root_slot).unwrap_or_default();
    if !active.trim().is_empty() {
        if let Ok(active_canon) = tokio::fs::canonicalize(active.trim()).await {
            if req_canon == active_canon {
                return assert_active_project_root(
                    project_root_slot,
                    project_root_identity_slot,
                    given,
                )
                .await;
            }
        }
    }

    // 2. native picker由来のworkspace grantに含まれるか。
    if crate::commands::project_authority::is_authorized_workspace_root(&req_canon).await {
        return Ok(ProjectRoot::from_canonical(req_canon));
    }

    tracing::warn!(
        requested = %clamp_for_log(&req_canon.to_string_lossy()),
        "[authz] assert_readable_project_root rejected: not active project nor workspace folder"
    );
    Err(CommandError::authz(
        "project_root does not match active project or authorized workspace root",
    ))
}

/// `req_canon` (canonicalize 済み) が `folders` のいずれかと canonicalize 一致し、かつ
/// その folder が `is_safe_watch_root` (system 領域 / home / drive root denylist, #963)
/// を通るか。存在しない / canonicalize できない / unsafe な folder エントリは skip する。
///
/// PR #962 auto-review: canonicalize は folder ごとに blocking I/O を伴うため、NFS/SMB 等の
/// 低速マウントで folder 数分の直列待ちにならないよう `JoinSet` で並列実行し、
/// 一致を見つけた時点で残りを打ち切る。
#[allow(dead_code)]
async fn matches_any_workspace_folder(req_canon: &std::path::Path, folders: &[String]) -> bool {
    let mut set = tokio::task::JoinSet::new();
    for folder in folders {
        let f = folder.trim();
        if f.is_empty() {
            continue;
        }
        let f = f.to_string();
        set.spawn(async move {
            // Issue #963: settings_save は workspaceFolders を無検証で受けるため、
            // ゲート通過条件としてここで safe root 検証を要求する (write 系の防御)。
            // `is_safe_watch_root` は **raw path を受け取り内部で canonicalize する**
            // 設計 (app_set_project_root #639 と同じ呼び方)。canonicalize 済みの
            // verbatim-prefix (`\\?\C:\...`) 付き path を渡すと Windows の denylist
            // (`c:\windows` 前方一致) が素通りするため、raw `f` を渡すこと。
            //
            // PR #968 auto-review: `is_safe_watch_root` は同期 blocking I/O
            // (`std::fs::canonicalize` + metadata) を含むため、Tokio ワーカースレッドを
            // 塞がないよう spawn_blocking に逃がす。canonicalize も同 blocking task 内で
            // 行い、async fs 呼び出しとの二重 I/O も避ける。
            tokio::task::spawn_blocking(move || {
                if !crate::commands::fs_watch::is_safe_watch_root(std::path::Path::new(&f)) {
                    tracing::warn!(
                        folder = %clamp_for_log(&f),
                        "[authz] workspace folder skipped by safe-root check"
                    );
                    return None;
                }
                // 比較は canonicalize 後の path で行う (req_canon も canonicalize 済み)。
                std::fs::canonicalize(&f).ok()
            })
            .await
            .ok()
            .flatten()
        });
    }
    while let Some(res) = set.join_next().await {
        if let Ok(Some(folder_canon)) = res {
            if folder_canon == req_canon {
                set.abort_all();
                return true;
            }
        }
    }
    false
}

/// Issue #601 (Tier A-3): renderer 由来の `team_id` が `TeamHub` の active set に含まれるかを
/// 検証する。`team_diagnostics_read` (#601) のような **renderer がリーダー視点を impersonate
/// する** IPC で、過去 / 別プロジェクト / 任意 fabricated な team_id を probe されないように
/// recon を抑止するための helper。
///
/// 設計判断:
/// - 「空 team_id」「未登録 team_id」「正常な team_id」のうち最初の 2 つは同じ
///   `Authz("team is not active or does not exist")` で reject する。これは存在 / 非存在を
///   区別しない recon 抑止の方針 (issue #601 案1)。
/// - reject 時は clamp 済み team_id を log に残す。空 team_id は `warn!` (caller bug)、
///   active set 未登録は `debug!` — Issue #802: 復元された stale team の team-health
///   poll 等で 日常的に発生するため WARN ノイズにしない。recon 抑止は generic message
///   側で担保しており log レベルとは独立。
/// - 返却型は `()` (active 確認だけが目的、戻り値で team の詳細を返さない)。
pub async fn assert_active_team(hub: &TeamHub, team_id: &str) -> CommandResult<()> {
    let trimmed = team_id.trim();
    if trimmed.is_empty() {
        tracing::warn!(
            team_id = %clamp_team_id_for_log(team_id),
            "[authz] assert_active_team rejected: empty team_id"
        );
        return Err(CommandError::authz("team is not active or does not exist"));
    }

    let state = hub.state.lock().await;
    if !state.active_teams.contains(trimmed) {
        // `members` の中に過去の (= dismiss 済み) team_id が残っていても probe させない。
        let active_count = state.active_teams.len();
        drop(state);
        // Issue #802: active set 未登録は dismiss 済み / 復元された stale team を probe
        // した想定内の結果で、起動時の team-health poll 等で 日常的に発生する。本物の
        // 異常用に WARN は温存し、ここは debug に下げて起動時ログのノイズを抑える。
        tracing::debug!(
            team_id = %clamp_team_id_for_log(team_id),
            active_count,
            "[authz] assert_active_team rejected: team_id not in active set"
        );
        return Err(CommandError::authz("team is not active or does not exist"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    /// Issue #1193: テスト用のactive rootとnative identity snapshotを対で作る。
    async fn make_lock(
        value: Option<String>,
    ) -> (
        ArcSwapOption<String>,
        ArcSwapOption<crate::commands::project_authority::ProjectRootIdentity>,
    ) {
        let identity = match value.as_deref() {
            Some(path) if !path.trim().is_empty() => {
                crate::commands::project_authority::capture_identity(path)
                    .await
                    .ok()
            }
            _ => None,
        };
        (
            ArcSwapOption::from(value.map(std::sync::Arc::new)),
            ArcSwapOption::from(identity.map(std::sync::Arc::new)),
        )
    }

    #[tokio::test]
    async fn rejects_empty_given() {
        let (lock, identity) = make_lock(Some("/tmp/whatever".to_string())).await;
        let err = assert_active_project_root(&lock, &identity, "")
            .await
            .unwrap_err();
        assert!(
            matches!(err, CommandError::Authz(ref m) if m.contains("empty")),
            "got: {err}"
        );
        // 全角空白を含む whitespace のみも reject
        let err = assert_active_project_root(&lock, &identity, "   \t  ")
            .await
            .unwrap_err();
        assert!(matches!(err, CommandError::Authz(ref m) if m.contains("empty")));
    }

    #[tokio::test]
    async fn rejects_when_no_active_project_root() {
        let (lock, identity) = make_lock(None).await;
        let dir = tempdir().expect("tempdir");
        let err =
            assert_active_project_root(&lock, &identity, dir.path().to_string_lossy().as_ref())
                .await
                .unwrap_err();
        assert!(
            matches!(err, CommandError::Authz(ref m) if m.contains("no active project_root")),
            "got: {err}"
        );

        // active が "" / whitespace のみのときも No active 判定。
        let (lock, identity) = make_lock(Some("   ".to_string())).await;
        let err =
            assert_active_project_root(&lock, &identity, dir.path().to_string_lossy().as_ref())
                .await
                .unwrap_err();
        assert!(matches!(err, CommandError::Authz(ref m) if m.contains("no active project_root")));
    }

    #[tokio::test]
    async fn rejects_when_given_does_not_exist() {
        let active = tempdir().expect("active tempdir");
        let (lock, identity) = make_lock(Some(active.path().to_string_lossy().into_owned())).await;

        // 存在しない path → canonicalize fail で reject
        let bogus = active.path().join("does-not-exist-xyz123");
        let err = assert_active_project_root(&lock, &identity, bogus.to_string_lossy().as_ref())
            .await
            .unwrap_err();
        assert!(
            matches!(err, CommandError::Authz(ref m) if m.contains("canonicalize requested project_root failed")),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn rejects_when_paths_differ() {
        let project_a = tempdir().expect("project A");
        let project_b = tempdir().expect("project B");
        // active は project_a
        let (lock, identity) =
            make_lock(Some(project_a.path().to_string_lossy().into_owned())).await;

        // 攻撃: renderer から project_b を渡す → canonicalize 比較で reject
        let err = assert_active_project_root(
            &lock,
            &identity,
            project_b.path().to_string_lossy().as_ref(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, CommandError::Authz(ref m) if m.contains("does not match active project")),
            "got: {err}"
        );
    }

    #[tokio::test]
    async fn accepts_when_paths_match() {
        let project = tempdir().expect("project");
        let (lock, identity) = make_lock(Some(project.path().to_string_lossy().into_owned())).await;

        // 同じ path を渡す → 一致して canonical path が返る
        let canon =
            assert_active_project_root(&lock, &identity, project.path().to_string_lossy().as_ref())
                .await
                .expect("matching paths should pass");
        assert_eq!(
            canon.as_path(),
            std::fs::canonicalize(project.path())
                .expect("canonicalize")
                .as_path(),
        );
    }

    // ---------- Issue #954: assert_readable_project_root ----------

    #[tokio::test]
    async fn readable_accepts_active_project_root() {
        let project = tempdir().expect("project");
        let (lock, identity) = make_lock(Some(project.path().to_string_lossy().into_owned())).await;
        let canon = assert_readable_project_root(
            &lock,
            &identity,
            project.path().to_string_lossy().as_ref(),
        )
        .await
        .expect("active root must be readable");
        assert_eq!(
            canon.as_path(),
            std::fs::canonicalize(project.path()).unwrap().as_path()
        );
    }

    #[tokio::test]
    async fn readable_rejects_empty_and_foreign_paths() {
        let active = tempdir().expect("active");
        let foreign = tempdir().expect("foreign");
        let (lock, identity) = make_lock(Some(active.path().to_string_lossy().into_owned())).await;

        let err = assert_readable_project_root(&lock, &identity, "")
            .await
            .unwrap_err();
        assert!(matches!(err, CommandError::Authz(ref m) if m.contains("empty")));

        // activeでもnative authority ledgerのworkspace grantでもない実在path → reject
        let err = assert_readable_project_root(
            &lock,
            &identity,
            foreign.path().to_string_lossy().as_ref(),
        )
        .await
        .unwrap_err();
        assert!(
            matches!(err, CommandError::Authz(ref m) if m.contains("authorized workspace root")),
            "got: {err}"
        );
    }

    /// Issue #963: settings_save は workspaceFolders を無検証で受けるため、system 領域が
    /// 登録されていてもゲートは通さない (write 系がシステム領域に届くのを防ぐ)。
    #[tokio::test]
    async fn workspace_folder_in_system_area_is_skipped() {
        #[cfg(windows)]
        let sys = "C:\\Windows";
        #[cfg(unix)]
        let sys = "/etc";
        let req = std::fs::canonicalize(sys).expect("system dir must exist");
        assert!(
            !matches_any_workspace_folder(&req, &[sys.to_string()]).await,
            "system-area workspace folder must be rejected by safe-root check"
        );
    }

    #[tokio::test]
    async fn workspace_folder_matching_is_canonical_and_skips_missing() {
        let folder = tempdir().expect("folder");
        let req = std::fs::canonicalize(folder.path()).unwrap();
        // 実在 folder は raw 表記が違っても canonicalize 一致で許可
        let raw = format!(
            "{}{}",
            folder.path().to_string_lossy(),
            std::path::MAIN_SEPARATOR
        );
        assert!(matches_any_workspace_folder(&req, &[raw]).await);
        // 存在しない folder / 空文字エントリは skip され、一致しない
        assert!(
            !matches_any_workspace_folder(
                &req,
                &[
                    "".into(),
                    "   ".into(),
                    folder.path().join("nope").to_string_lossy().into_owned()
                ]
            )
            .await
        );
    }

    #[tokio::test]
    async fn accepts_when_paths_differ_only_in_canonical_form() {
        // active path に末尾 separator や `./` を加えても canonicalize で同一になるなら通る。
        let project = tempdir().expect("project");
        let active_raw = project.path().to_string_lossy().into_owned();
        let (lock, identity) = make_lock(Some(active_raw.clone())).await;

        // 末尾 separator を付けた variant を given にする
        let mut given = active_raw.clone();
        if !given.ends_with(std::path::MAIN_SEPARATOR) {
            given.push(std::path::MAIN_SEPARATOR);
        }
        let canon = assert_active_project_root(&lock, &identity, &given)
            .await
            .expect("trailing separator should canonicalize equal");
        assert_eq!(
            canon.as_path(),
            std::fs::canonicalize(project.path())
                .expect("canon")
                .as_path()
        );
    }

    /// Issue #1147: Windowsのcanonical snapshotはverbatim prefixを含み得る。
    /// symlink retarget後もI/Oで再解決せず、区切りとcaseだけをpureに正規化する。
    #[cfg(windows)]
    #[test]
    fn canonical_comparison_key_normalizes_windows_without_io() {
        let root =
            ProjectRoot::assume_canonical_for_test(PathBuf::from(r"\\?\C:\Users\YUSEI\Repo\"));
        assert_eq!(root.comparison_key(), "//?/c:/users/yusei/repo");
    }

    // ===== Issue #601 (Tier A-3): assert_active_team helper =====

    mod active_team {
        use super::*;
        use crate::pty::SessionRegistry;
        use crate::team_hub::TeamHub;
        use std::sync::Arc;

        async fn insert_active_team(hub: &TeamHub, team_id: &str) {
            let mut s = hub.state.lock().await;
            s.active_teams.insert(team_id.to_string());
        }

        /// active set に登録された team_id は accept される。
        #[tokio::test]
        async fn accepts_team_id_in_active_set() {
            let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
            insert_active_team(&hub, "team-active-001").await;
            assert_active_team(&hub, "team-active-001")
                .await
                .expect("active team_id should be accepted");
        }

        /// active set に居ない team_id は recon 抑止の generic message で reject される。
        #[tokio::test]
        async fn rejects_team_id_not_in_active_set() {
            let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
            insert_active_team(&hub, "team-active-002").await;
            // 別の team_id (= 過去に dismiss した / 別 project の team / fabricated) を渡す
            let err = assert_active_team(&hub, "team-of-projectA-fabricated")
                .await
                .unwrap_err();
            assert!(
                matches!(err, CommandError::Authz(ref m) if m == "team is not active or does not exist"),
                "got: {err}"
            );
        }

        /// 存在しない / 空の team_id は同じ generic message で reject される
        /// (= recon 抑止: 存在 / 非存在を区別しない)。
        #[tokio::test]
        async fn rejects_empty_team_id_with_same_message_as_unknown() {
            let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
            insert_active_team(&hub, "team-active-003").await;

            let err_empty = assert_active_team(&hub, "").await.unwrap_err();
            let err_whitespace = assert_active_team(&hub, "   ").await.unwrap_err();
            let err_unknown = assert_active_team(&hub, "team-unknown-xyz")
                .await
                .unwrap_err();

            // 全部同じ generic message にすることで「team_id がそもそも空」と
            // 「team_id が active set に居ない」を caller から区別できなくする。
            for err in [&err_empty, &err_whitespace, &err_unknown] {
                assert!(
                    matches!(err, CommandError::Authz(ref m) if m == "team is not active or does not exist"),
                    "got: {err}"
                );
            }
        }

        /// dismiss された team_id は accept されない
        /// (= state.active_teams.remove で集合から外れているはず)。
        #[tokio::test]
        async fn rejects_team_id_after_remove() {
            let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
            insert_active_team(&hub, "team-tmp").await;
            // 一度 accept される
            assert_active_team(&hub, "team-tmp")
                .await
                .expect("should accept while in active set");
            // 集合から外す (dismiss 相当)
            {
                let mut s = hub.state.lock().await;
                s.active_teams.remove("team-tmp");
            }
            // 以降は generic reject に変わる
            let err = assert_active_team(&hub, "team-tmp").await.unwrap_err();
            assert!(
                matches!(err, CommandError::Authz(ref m) if m == "team is not active or does not exist"),
                "got: {err}"
            );
        }

        /// `team_id` を trim したうえで active set と比較する
        /// (= `"  team-x  "` のような padding は無害化して accept させる)。
        #[tokio::test]
        async fn accepts_team_id_after_trim() {
            let hub = TeamHub::new(Arc::new(SessionRegistry::new()));
            insert_active_team(&hub, "team-trimmed").await;
            assert_active_team(&hub, "  team-trimmed  ")
                .await
                .expect("trim 済み team_id should be accepted");
        }
    }
}
