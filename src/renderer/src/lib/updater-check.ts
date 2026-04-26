/**
 * Tauri updater 起動時 / 手動チェック。
 *
 * 旧実装の問題点と修正:
 *   - エラー全 console.debug → toast に出す (manual モードでは必ず表示)
 *   - window.confirm → @tauri-apps/plugin-dialog の ask (テーマ追従, 多言語フォント OK)
 *   - 進捗無し → onEvent コールバックで Toast 進捗 (10% 刻み)
 *   - didCheck を try 前で立てる → 成功時のみフラグ
 *   - release notes 無制限 → 600 文字で truncate
 *   - 実行中タスクが警告無く死ぬ → ダイアログに警告追加
 *   - Windows での relaunch 二重 → NSIS 任せ (非 Windows のみ relaunch)
 */
import type { Language } from '../../../types/shared';
import { translate } from './i18n';

export interface UpdaterDeps {
  language: Language;
  showToast: (
    message: string,
    options?: { duration?: number; tone?: 'info' | 'success' | 'warning' | 'error' }
  ) => number;
  dismissToast?: (id: number) => void;
  /** 起動時の自動チェックなら省略 / false。設定 or コマンドからの手動なら true。
   *  manual=true のときは didAutoCheck を無視し、また「最新です」「失敗」も明示通知する。 */
  manual?: boolean;
  /** 実行中の Claude/Codex タブ数 (確認ダイアログで警告) */
  runningTaskCount?: number;
}

const MAX_BODY_CHARS = 600;
let didAutoCheck = false;

/**
 * Issue #142: downgrade 防止。Tauri plugin-updater は通常 update.version > current で
 * しか update を返さないが、CI で生成する `latest.json` の version 文字列が手動で
 * いじられた等のエッジケースに備えて、renderer 側でも明示的に semver 比較を行う。
 *
 * セマンティックバージョンの簡易比較。プレリリース部分は trailing tail として string 比較
 * (主目的は「より小さいバージョン」が来たときに updater を抑止すること)。
 */
function isStrictlyNewer(candidate: string, current: string): boolean {
  const parse = (v: string): { nums: number[]; tail: string } => {
    const m = v.match(/^v?(\d+)\.(\d+)\.(\d+)(.*)$/);
    if (!m) return { nums: [0, 0, 0], tail: v };
    return {
      nums: [Number(m[1]), Number(m[2]), Number(m[3])],
      tail: m[4]
    };
  };
  const a = parse(candidate);
  const b = parse(current);
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] > b.nums[i]) return true;
    if (a.nums[i] < b.nums[i]) return false;
  }
  // メジャー / マイナー / パッチが一致したら tail 比較
  // 例: 1.3.1-beta.2 > 1.3.1-beta.1 は安全側で false (= 同等扱い) とし、
  // 純粋な「より古いバージョン」が偽装してきたケースだけ防げれば十分。
  return a.tail > b.tail && b.tail !== '';
}

function isWindowsPlatform(): boolean {
  // Tauri 2 の navigator.userAgentData が WebView2 で undefined になりうるので両対応
  if (typeof navigator !== 'undefined') {
    const ua = (navigator.userAgent || '').toLowerCase();
    if (ua.includes('windows')) return true;
  }
  return false;
}

export async function checkForUpdates(deps: UpdaterDeps): Promise<void> {
  const { language, showToast, dismissToast, manual = false, runningTaskCount = 0 } = deps;
  // 自動チェックは prod のみ。manual の場合は dev でも走らせて挙動確認できるようにする。
  if (!manual && didAutoCheck) return;
  if (!manual && !import.meta.env.PROD) return;

  // ---------- 1. check() ----------
  let update: Awaited<ReturnType<typeof import('@tauri-apps/plugin-updater').check>>;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    update = await check();
  } catch (err) {
    if (manual) {
      showToast(translate(language, 'updater.checkFailed', { error: String(err) }), {
        tone: 'error'
      });
    } else {
      console.debug('[updater] check skipped:', err);
    }
    return;
  }

  if (!update) {
    if (manual) {
      showToast(translate(language, 'updater.upToDate'), { tone: 'success' });
    }
    didAutoCheck = true;
    return;
  }
  didAutoCheck = true;

  // Issue #142 (Security): downgrade 防止。
  // current 版本が取れない場合 (古い Tauri など) はチェックを skip するが、
  // 通常 update.currentVersion が入っているはず。明示的に semver 比較する。
  const currentVersion = (update as unknown as { currentVersion?: string }).currentVersion ?? '';
  if (currentVersion && !isStrictlyNewer(update.version, currentVersion)) {
    console.warn(
      '[updater] suppressing non-newer update offer:',
      'candidate=',
      update.version,
      'current=',
      currentVersion
    );
    if (manual) {
      showToast(translate(language, 'updater.upToDate'), { tone: 'success' });
    }
    return;
  }

  // ---------- 2. confirm dialog (Tauri native) ----------
  const rawBody = update.body ?? '';
  const body =
    rawBody.length > MAX_BODY_CHARS ? `${rawBody.slice(0, MAX_BODY_CHARS).trimEnd()}…` : rawBody;
  const warning =
    runningTaskCount > 0
      ? `\n\n${translate(language, 'updater.runningTasksWarning', {
          count: runningTaskCount
        })}`
      : '';
  const message =
    translate(language, 'updater.confirm', { version: update.version }) +
    warning +
    (body ? `\n\n${body}` : '');

  let proceed = false;
  try {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    proceed = await ask(message, { title: 'vibe-editor', kind: 'info' });
  } catch (err) {
    showToast(translate(language, 'updater.dialogFailed', { error: String(err) }), {
      tone: 'error'
    });
    return;
  }
  if (!proceed) return;

  // ---------- 3. download & install with progress ----------
  let total = 0;
  let downloaded = 0;
  let lastBucket = -1;
  // Issue #121: 「最新の」進捗 toast id を保持して、新しい toast を出す前に必ず dismiss する。
  // 旧実装は初回 toast の id (progressId) しか覚えておらず、10% 刻みで新規 toast を作り続けた結果
  // ダウンロード中ずっと info toast が積み上がっていた。currentToastId をローカル変数で更新する。
  let currentToastId: number = showToast(translate(language, 'updater.downloading'), {
    tone: 'info',
    // 進捗 toast は完了 / エラー時に dismiss するので長めに
    duration: 600_000
  });

  try {
    await update.downloadAndInstall((event) => {
      if (event.event === 'Started') {
        total = event.data.contentLength ?? 0;
      } else if (event.event === 'Progress') {
        downloaded += event.data.chunkLength;
        if (total > 0) {
          const pct = Math.floor((downloaded / total) * 100);
          // 10% 刻みで toast を更新 (高頻度に dismiss/show すると瞬く)
          const bucket = Math.floor(pct / 10);
          if (bucket > lastBucket) {
            lastBucket = bucket;
            // Issue #121: 直前の toast を dismiss してから新しい toast を出し、id を更新する。
            dismissToast?.(currentToastId);
            currentToastId = showToast(
              translate(language, 'updater.downloadProgress', { pct }),
              {
                tone: 'info',
                duration: 600_000
              }
            );
          }
        }
      } else if (event.event === 'Finished') {
        dismissToast?.(currentToastId);
        currentToastId = showToast(translate(language, 'updater.installing'), {
          tone: 'info',
          duration: 30_000
        });
      }
    });
  } catch (err) {
    dismissToast?.(currentToastId);
    showToast(translate(language, 'updater.downloadFailed', { error: String(err) }), {
      tone: 'error',
      duration: 8_000
    });
    return;
  }

  // ---------- 4. relaunch ----------
  // Windows: NSIS インストーラが自動でアプリを終了 → 再起動するので relaunch は呼ばない。
  // 呼んでも害は少ないが、競合タイミングで relaunch エラーが出てユーザーを混乱させうる。
  if (isWindowsPlatform()) return;

  try {
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (err) {
    showToast(translate(language, 'updater.relaunchFailed', { error: String(err) }), {
      tone: 'warning',
      duration: 8_000
    });
  }
}

/** 自動チェック用の after-build フラグをリセット (テスト / 手動再試行用) */
export function resetAutoCheckFlag(): void {
  didAutoCheck = false;
}
