# Issue #579 — PTY spawn 所要時間メトリクス: 観測ノート

このドキュメントは Issue #579 で導入した PTY spawn 計測ログ (`[pty] spawn ok` / `[pty] spawn failed`) の **集計手順** と、観測値から **次 issue を起票するかの判定基準** を記録するためのもの。

## 出力フォーマット

`src-tauri/src/pty/session.rs::log_spawn_outcome` から `tracing::info!` / `tracing::warn!` で出る。`target` は `pty`、構造化フィールドは以下:

| field        | 例                       | 説明                                                  |
|--------------|--------------------------|-------------------------------------------------------|
| `command`    | `claude.cmd`             | basename + extension (フルパスは漏らさない)。`redact_home` 通過済み |
| `engine`     | `claude` / `codex`       | `SpawnOptions::is_codex` から判定                      |
| `platform`   | `windows` / `macos` / `linux` | `cfg!(target_os = ...)` で判定                  |
| `elapsed_ms` | `1234`                   | `Instant::now()` から `pair.slave.spawn_command(cmd)` 完了までの ms |
| `error`      | `executable not found`   | 失敗時のみ。spawn_command の `anyhow::Error` の Display |

成功/失敗で別メッセージ:

- 成功: `info!("[pty] spawn ok")`
- 失敗: `warn!("[pty] spawn failed")`

ログは vibe-editor の標準ロガー (`tracing-subscriber` + `tracing-appender`) で `~/.vibe-editor/logs/vibe-editor.log` に書き出される (Issue #326)。

## 集計方法 (Windows / PowerShell)

vibe-editor を起動 → claude / codex を 5 回ずつ recruit → アプリを閉じて以下を実行:

```powershell
# ログファイルパス
$log = Join-Path $env:USERPROFILE ".vibe-editor\logs\vibe-editor.log"

# spawn ok 行から elapsed_ms を抽出
$elapsed = Select-String -Path $log -Pattern '\[pty\] spawn ok' |
    ForEach-Object {
        if ($_.Line -match 'elapsed_ms=(\d+)') { [int]$Matches[1] }
    }

# 件数 / 中央値 / p95
$n = $elapsed.Count
$sorted = $elapsed | Sort-Object
"count: $n"
"p50  : $($sorted[[int][math]::Floor($n * 0.5)]) ms"
"p95  : $($sorted[[int][math]::Floor($n * 0.95)]) ms"
"max  : $(($sorted | Select-Object -Last 1)) ms"
```

engine / platform 別に分ける場合:

```powershell
# 注意: tracing-subscriber の既定 formatter は文字列フィールドを quote せず
# `engine=claude` `platform=windows` のような key=value で出すため、正規表現も unquoted で書く。
Select-String -Path $log -Pattern '\[pty\] spawn ok' |
    ForEach-Object {
        $line = $_.Line
        $engine   = if ($line -match 'engine=(\w+)')   { $Matches[1] } else { '?' }
        $platform = if ($line -match 'platform=(\w+)') { $Matches[1] } else { '?' }
        $ms       = if ($line -match 'elapsed_ms=(\d+)') { [int]$Matches[1] } else { 0 }
        [pscustomobject]@{ engine = $engine; platform = $platform; ms = $ms }
    } |
    Group-Object engine, platform |
    ForEach-Object {
        $vals = ($_.Group.ms | Sort-Object)
        $n = $vals.Count
        [pscustomobject]@{
            bucket = $_.Name
            count  = $n
            p50_ms = $vals[[int][math]::Floor($n * 0.5)]
            p95_ms = $vals[[int][math]::Floor($n * 0.95)]
        }
    }
```

## 集計方法 (macOS / Linux)

```bash
LOG="$HOME/.vibe-editor/logs/vibe-editor.log"
grep '\[pty\] spawn ok' "$LOG" \
    | grep -oE 'elapsed_ms=[0-9]+' \
    | cut -d= -f2 \
    | sort -n \
    | awk '{
        a[NR]=$1
      } END {
        n=NR
        printf "count: %d\np50  : %d ms\np95  : %d ms\nmax  : %d ms\n", \
            n, a[int(n*0.5)+1], a[int(n*0.95)+1], a[n]
      }'
```

## 失敗パスの確認

存在しないコマンドを spawn したときに `[pty] spawn failed` が出ることを確認する:

```powershell
Select-String -Path $log -Pattern '\[pty\] spawn failed'
```

`elapsed_ms` と `error` フィールドが両方記録されているか目視チェック。`prepare_spawn_command` の段階で弾かれる (allowlist 違反等) のは `[pty] spawn failed` には来ないので、portable-pty の `spawn_command` 自体が失敗したケースだけが集まる。

## 次 issue を起票する判定基準

Issue #574 の handshake timeout は **30 秒**。中央値がこの **10% = 3 秒 (3000 ms)** を超えるなら、PTY spawn の最適化を別 issue で起票する。具体的には以下のいずれかで起票:

| 条件                                       | 起票内容                                    |
|--------------------------------------------|---------------------------------------------|
| Windows の `engine=claude` で p50 ≥ 3000ms | claude shim 解決の最適化 issue              |
| Windows の `engine=codex` で p50 ≥ 3000ms  | codex shim 解決の最適化 issue               |
| 任意プラットフォームで p95 ≥ 10000ms       | PTY pool / lazy spawn 検討 issue            |
| 失敗率 (failed / (ok+failed)) > 5%         | spawn 信頼性 issue (root cause 別途調査)    |

### 判定材料の最低サンプル数

- 1 platform × 1 engine あたり最低 **20 サンプル**。それ未満なら判定保留。
- 集計期間は **約 1 週間**を目安にする (週次でしか計測しないなら 2 週間)。

### 起票時に転記する数字

- `count` / `p50` / `p95` / `max`
- engine × platform の bucket
- 集計期間 (例: 2026-05-08 〜 2026-05-15)

## 関連

- 親 Issue: #574 (Phase 1) — Canvas モードでの recruit 5s ack timeout
- 本 Issue: #579 (Phase 2 follow-up) — 観測ログのみ
- 関連 PR: #557 / #561 / #565 / #571 / #573 (PTY shim 解決系)
- 計測コード: `src-tauri/src/pty/session.rs::log_spawn_outcome`
