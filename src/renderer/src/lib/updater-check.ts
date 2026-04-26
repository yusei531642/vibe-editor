/**
 * Tauri updater モジュール。
 *
 * 旧仕様: 起動時に自動で「アップデートあり → ask → 即 install → relaunch」を行っていた。
 *         体感的には「起動して数秒したら無言でアプリが落ち、再起動 = 更新」となり、
 *         作業中タブを書き戻す前にプロセスが死ぬ事故報告が複数あったため撤廃する。
 * 新仕様:
 *   - 起動時は `silentCheckForUpdate()` で「更新があるか」だけを検出 (UI 副作用なし)。
 *     呼び出し側 (App / CanvasLayout) は結果を `useUiStore.setAvailableUpdate()` に
 *     書き、Topbar / CanvasLayout 右上の「Update vX.Y.Z」ボタンを表示する。
 *   - ユーザーが明示的にボタンを押したときだけ `runUpdateInstall()` が走る。
 *     旧 `checkForUpdates` は manual=true パスとして残す (コマンドパレット / ヘルプメニュー
 *     からの「更新を確認」用、最新時 toast や失敗 toast を出す挙動を維持)。
 *
 * 進捗 toast / Issue #121 (toast 重ね焼け回避) / Issue #142 (downgrade 防止) /
 * Issue #59 (i18n) / Windows NSIS 二重 relaunch 回避 はすべて維持する。
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
  /** コマンドパレット / ヘルプメニューからの手動チェック。最新時の通知や失敗 toast を出す。 */
  manual?: boolean;
  /** 実行中の Claude/Codex タブ数 (確認ダイアログで警告) */
  runningTaskCount?: number;
}

/** silentCheck で外部に渡す軽量な更新メタ情報。raw な Update オブジェクトは保持しない
 *  (再 install 時にもう一度 check() を呼び直すので問題ない)。 */
export interface AvailableUpdateInfo {
  version: string;
  currentVersion: string;
  /** リリースノート本文 (truncate 済み) */
  body: string;
}

const MAX_BODY_CHARS = 600;

/**
 * Issue #142: downgrade 防止。Tauri plugin-updater は通常 update.version > current で
 * しか update を返さないが、CI で生成する `latest.json` の version 文字列が手動で
 * いじられた等のエッジケースに備えて、renderer 側でも明示的に semver 比較を行う。
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
  return a.tail > b.tail && b.tail !== '';
}

function isWindowsPlatform(): boolean {
  if (typeof navigator !== 'undefined') {
    const ua = (navigator.userAgent || '').toLowerCase();
    if (ua.includes('windows')) return true;
  }
  return false;
}

function truncateBody(raw: string): string {
  return raw.length > MAX_BODY_CHARS ? `${raw.slice(0, MAX_BODY_CHARS).trimEnd()}…` : raw;
}

/**
 * UI 副作用なしで「より新しい更新があるか」だけを返す。
 * - prod でしか走らせない (dev は plugin-updater の signature 検証で常に失敗する)
 * - 失敗時は console.debug に落として null を返す (起動を止めない)
 * - 無更新 / 同等以下バージョンの場合も null
 */
export async function silentCheckForUpdate(): Promise<AvailableUpdateInfo | null> {
  if (!import.meta.env.PROD) return null;

  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (!update) return null;

    const currentVersion = (update as unknown as { currentVersion?: string }).currentVersion ?? '';
    if (currentVersion && !isStrictlyNewer(update.version, currentVersion)) {
      console.warn(
        '[updater] suppressing non-newer update offer:',
        'candidate=',
        update.version,
        'current=',
        currentVersion
      );
      return null;
    }
    return {
      version: update.version,
      currentVersion,
      body: truncateBody(update.body ?? '')
    };
  } catch (err) {
    console.debug('[updater] silent check skipped:', err);
    return null;
  }
}

/**
 * 実際の install フロー。ボタンクリックで呼ばれる。
 * もう一度 check() を走らせて raw Update を取り直し、確認ダイアログ → DL → install → relaunch。
 * silent check で取れた版以外が降ってくる可能性 (CI が直前に latest.json を再アップロード)
 * もあるが、その場合はダイアログにそのまま新しい version を出すのが正しい挙動。
 */
export async function runUpdateInstall(deps: UpdaterDeps): Promise<void> {
  const { language, showToast, dismissToast, manual = false, runningTaskCount = 0 } = deps;

  // ---------- 1. check() ----------
  let update: Awaited<ReturnType<typeof import('@tauri-apps/plugin-updater').check>>;
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    update = await check();
  } catch (err) {
    showToast(translate(language, 'updater.checkFailed', { error: String(err) }), {
      tone: 'error'
    });
    return;
  }

  if (!update) {
    showToast(translate(language, 'updater.upToDate'), { tone: 'success' });
    return;
  }

  const currentVersion = (update as unknown as { currentVersion?: string }).currentVersion ?? '';
  if (currentVersion && !isStrictlyNewer(update.version, currentVersion)) {
    console.warn(
      '[updater] suppressing non-newer update offer:',
      'candidate=',
      update.version,
      'current=',
      currentVersion
    );
    showToast(translate(language, 'updater.upToDate'), { tone: 'success' });
    return;
  }

  // ---------- 2. confirm dialog (Tauri native) ----------
  const body = truncateBody(update.body ?? '');
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
  let currentToastId: number = showToast(translate(language, 'updater.downloading'), {
    tone: 'info',
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
          const bucket = Math.floor(pct / 10);
          if (bucket > lastBucket) {
            lastBucket = bucket;
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
  // manual パラメータは現状特に追加挙動を持たないが、将来の差別化用に署名は維持。
  void manual;
}

/**
 * 旧 API 互換: 「ヘルプメニュー / コマンドパレットからの『更新を確認』」用。
 * silent check と install 起動を 1 回で行う。manual=true 相当の挙動 (最新時の toast を出す)。
 */
export async function checkForUpdates(deps: UpdaterDeps): Promise<void> {
  await runUpdateInstall({ ...deps, manual: true });
}
