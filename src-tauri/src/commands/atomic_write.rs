// Atomic write helper
//
// Issue #37: settings.json / team-history.json / ~/.claude.json などの永続ファイルを
// `tokio::fs::write()` で直接上書きすると、書き込み中のクラッシュ/電源断で半端な JSON
// (空 or 途中で切れた) が残り、次回起動時に parse 失敗 → デフォルト巻き戻り、という事故が
// 起きる。特に `~/.claude.json` は他アプリと共有なのでユーザー影響が大きい。
//
// 対策: `<target>.tmp.<pid>.<rand>` に書き、fsync して rename で atomic 置換する。
// POSIX も Windows も rename は same-volume なら atomic (Windows は MoveFileEx + REPLACE_EXISTING)。
//
// Issue #608 (Security): `~/.claude.json` / `~/.codex/config.toml` / role-profiles 等の
// 機密ファイルは 0o600 を強制したい。temp ファイル作成時の OpenOptions::mode + rename 後の
// set_permissions の二段で defense-in-depth に umask 漏れを潰す (Unix のみ effective、
// Windows は no-op で fallback。Windows ACL 強制は別 issue で対応)。

use anyhow::{anyhow, Result};
use std::path::{Path, PathBuf};
use tokio::fs;
use tokio::io::AsyncWriteExt;

/// 指定 path にバイト列を atomic に書き込む。親ディレクトリは自動作成。
/// mode は OS デフォルト (umask 反映) — 0o600 等を強制したいケースは
/// [`atomic_write_with_mode`] を使う。
pub async fn atomic_write(target: &Path, bytes: &[u8]) -> Result<()> {
    atomic_write_with_mode(target, bytes, None).await
}

/// 指定 path にバイト列を atomic に書き込む。`mode` を `Some(m)` で渡すと
/// Unix では (1) tmp ファイル作成時に `OpenOptions::mode(m)` で開き、
/// (2) rename 後にも `set_permissions(m)` で defense-in-depth な再設定を行う。
/// Windows では mode は無視 (no-op) — Windows ACL 強制は別 issue 案件。
///
/// `mode = None` は OS デフォルト動作 (= [`atomic_write`] と等価) を意味する。
pub async fn atomic_write_with_mode(
    target: &Path,
    bytes: &[u8],
    // Windows では mode 引数は no-op なので unused variable 警告が出る。
    // unix / non-unix で同じシグネチャを公開したいので cfg_attr で抑制。
    #[cfg_attr(not(unix), allow(unused_variables))] mode: Option<u32>,
) -> Result<()> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).await?;
    }
    // temp ファイル名は同ディレクトリ内に (rename が atomic になる条件)
    // Issue #169: 旧 tmp 名 `.{file}.tmp.{pid}.{nanos}` は同プロセス内の同時 atomic_write が
    // 同一ナノ秒に揃うと衝突しうる (settings リサイズ + role profile save 並行時など)。
    // uuid v4 を混ぜて衝突確率を実質ゼロにする。
    let tmp = {
        let file_name = target.file_name().map_or_else(
            || "vibe.tmp".to_string(),
            |s| s.to_string_lossy().into_owned(),
        );
        let pid = std::process::id();
        let unique = uuid::Uuid::new_v4().simple().to_string();
        let tmp_name = format!(".{file_name}.tmp.{pid}.{unique}");
        match target.parent() {
            Some(p) => p.join(&tmp_name),
            None => PathBuf::from(&tmp_name),
        }
    };

    // Issue #187 (Security): tmp が攻撃者によって symlink 先置きされている可能性に備え、
    // O_CREAT | O_EXCL 相当の create_new=true で開く (既存があれば失敗)。
    // 加えて Unix では O_NOFOLLOW を付けて symlink を follow させない。
    {
        let mut opts = fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            // O_NOFOLLOW (linux: 0x20000, macOS: 0x100). libc クレートを使わずに数値で指定するのは
            // 非互換になりやすいので tokio が提供する custom_flags 経由を採用。
            // libc が無い場合でも O_EXCL で symlink → target file 上書きはほぼ防げる。
            #[cfg(target_os = "linux")]
            opts.custom_flags(0x20000); // O_NOFOLLOW (Linux)
            #[cfg(target_os = "macos")]
            opts.custom_flags(0x0100); // O_NOFOLLOW (macOS / BSD)
            // Issue #608: tmp ファイル作成時点で mode を反映 (umask の影響を受けない)。
            // mode=None のときは OpenOptions::mode を呼ばず、従来通り OS デフォルトに任せる。
            if let Some(m) = mode {
                opts.mode(m);
            }
        }
        let mut f = match opts.open(&tmp).await {
            Ok(f) => f,
            Err(e) => {
                return Err(anyhow!("atomic_write open tmp failed: {e}"));
            }
        };
        f.write_all(bytes).await?;
        f.flush().await?;
        // sync_all で metadata も含めてディスクへ flush
        f.sync_all().await.ok();
    }

    // rename で atomic 置換。Windows は同 volume 内なら既存ファイルの置換もアトミック
    // (Rust の rename は内部で MoveFileExW + MOVEFILE_REPLACE_EXISTING を呼ぶ)。
    if let Err(e) = fs::rename(&tmp, target).await {
        // 失敗時は temp を掃除して error を上げる (target は旧状態のまま残るので安全)
        let _ = fs::remove_file(&tmp).await;
        return Err(e.into());
    }

    // Issue #608 (Security): defense-in-depth — rename 後にも明示的に set_permissions。
    // OpenOptions::mode は umask の AND を取るため、`umask 0o077` のような厳しい設定環境では
    // 期待値より絞られるだけだが、逆に caller が rename で既存 0o644 ファイルを上書きする
    // ケースで「temp の 0o600 が target に引き継がれない」OS 実装も存在する (POSIX 仕様外動作)。
    // 安全側に倒すため set_permissions で確実に設定する。
    // permissions 設定の失敗は致命的ではない (ファイル本体は書けている) ので tracing で警告のみ。
    #[cfg(unix)]
    if let Some(m) = mode {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = fs::set_permissions(target, std::fs::Permissions::from_mode(m)).await {
            tracing::warn!(
                "[atomic_write] set_permissions({:o}) failed for {}: {e}",
                m,
                target.display()
            );
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn atomic_write_creates_file_with_content() {
        let dir = std::env::temp_dir().join(format!("vibe-atomic-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir).await;
        let target = dir.join("example.json");
        atomic_write(&target, b"{\"a\":1}").await.unwrap();
        let got = fs::read(&target).await.unwrap();
        assert_eq!(&got, b"{\"a\":1}");
        let _ = fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn atomic_write_replaces_existing() {
        let dir =
            std::env::temp_dir().join(format!("vibe-atomic-test-replace-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir).await;
        let target = dir.join("example.json");
        atomic_write(&target, b"v1").await.unwrap();
        atomic_write(&target, b"v2").await.unwrap();
        let got = fs::read(&target).await.unwrap();
        assert_eq!(&got, b"v2");
        let _ = fs::remove_dir_all(&dir).await;
    }

    #[tokio::test]
    async fn atomic_write_with_mode_none_behaves_like_atomic_write() {
        // mode=None は atomic_write と等価 (file は書けるが mode 強制は行わない)
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("plain.json");
        atomic_write_with_mode(&target, b"v1", None).await.unwrap();
        let got = fs::read(&target).await.unwrap();
        assert_eq!(&got, b"v1");
    }

    /// Issue #608: Unix で mode=Some(0o600) を指定したとき、書き込まれた target の
    /// permissions が 0o600 (= rw-------) で揃っていることを検証。
    #[cfg(unix)]
    #[tokio::test]
    async fn atomic_write_with_mode_enforces_0o600_on_unix() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("secret.json");
        atomic_write_with_mode(&target, b"sensitive", Some(0o600))
            .await
            .unwrap();
        let meta = std::fs::metadata(&target).unwrap();
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(mode, 0o600, "target should be enforced to 0o600 (got {mode:o})");
    }

    /// Issue #608: rename 上書きでも mode が 0o600 に再設定されること。
    /// (元ファイルが 0o644 で先に存在していたケースの defense-in-depth 検証)
    #[cfg(unix)]
    #[tokio::test]
    async fn atomic_write_with_mode_re_tightens_permissions_on_overwrite() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("secret.json");
        // 先に 0o644 で書いておく
        fs::write(&target, b"old").await.unwrap();
        fs::set_permissions(&target, std::fs::Permissions::from_mode(0o644))
            .await
            .unwrap();
        // 0o600 を強制して上書き
        atomic_write_with_mode(&target, b"new", Some(0o600))
            .await
            .unwrap();
        let meta = std::fs::metadata(&target).unwrap();
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o600,
            "rename overwrite should re-tighten target to 0o600 (got {mode:o})"
        );
        let got = fs::read(&target).await.unwrap();
        assert_eq!(&got, b"new");
    }

    /// Windows では mode 引数は no-op (失敗しないこと、内容が書けること) を確認。
    #[cfg(windows)]
    #[tokio::test]
    async fn atomic_write_with_mode_is_noop_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("secret.json");
        atomic_write_with_mode(&target, b"sensitive", Some(0o600))
            .await
            .unwrap();
        let got = fs::read(&target).await.unwrap();
        assert_eq!(&got, b"sensitive");
    }
}
