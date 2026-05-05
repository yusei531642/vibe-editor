import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Check, Plus, Search, X } from 'lucide-react';
import type { AgentConfig, AppSettings } from '../../../types/shared';
import { DEFAULT_SETTINGS } from '../../../types/shared';
import { useT } from '../lib/i18n';
import { useToast } from '../lib/toast-context';
import { useSpringMount } from '../lib/use-animated-mount';
import { EDITOR_FONT_PRESETS, UI_FONT_PRESETS } from '../lib/settings-options';
import { iconFor, labelOf, type SectionId } from '../lib/settings-section-meta';
import { useSettingsKeydown } from '../lib/hooks/use-settings-keydown';
import { useSettingsNav } from '../lib/hooks/use-settings-nav';
import { LanguageSection } from './settings/LanguageSection';
import { ThemeSection } from './settings/ThemeSection';
import { MascotSection } from './settings/MascotSection';
import { FontFamilySection } from './settings/FontFamilySection';
import { TerminalSection } from './settings/TerminalSection';
import { RoleProfilesSection } from './settings/RoleProfilesSection';
import { DensitySection } from './settings/DensitySection';
import { CommandOptionsSection } from './settings/CommandOptionsSection';
import { CustomAgentEditor } from './settings/CustomAgentEditor';
import { McpSection } from './settings/McpSection';
import { LogsSection } from './settings/LogsSection';

interface SettingsModalProps {
  open: boolean;
  initial: AppSettings;
  onClose: () => void;
  onApply: (next: AppSettings) => void;
  /**
   * Issue #28 対応: 現在は未使用 (Reset ボタンは draft だけを戻し、永続化は Apply に委ねる)。
   * 互換のためシグネチャは残している。将来「即時に保存したいリセット」導線が欲しくなったら
   * 呼び出し元に戻せる。
   */
  onReset?: () => void;
  /** 初回セットアップウィザードを再表示する (General セクションの専用ボタン) */
  onReplayOnboarding?: () => void;
}

export function SettingsModal({
  open,
  initial,
  onClose,
  onApply,
  onReplayOnboarding
}: SettingsModalProps): JSX.Element | null {
  const t = useT();
  const { showToast } = useToast();
  const [draft, setDraft] = useState<AppSettings>(initial);
  const [activeSection, setActiveSection] = useState<SectionId>('general');
  // 「適用して保存」押下時に短時間だけ ✓ アイコンに切り替えて操作完了を伝える
  const [saved, setSaved] = useState(false);
  // saved → false / onClose に切り替える deferred timer。
  // unmount / 直前の Apply キャンセルで必ずクリアする (アンマウント済み state 更新警告を防ぐ)。
  // 型は ReturnType を使うことで browser (number) / Node 系 (NodeJS.Timeout) どちらでも安全。
  const saveTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);
  // サイドバー検索 (空文字なら全表示)
  const [navQuery, setNavQuery] = useState('');
  // Issue #195: focus trap + Escape + autofocus 用のルート ref
  const dialogRef = useRef<HTMLDivElement | null>(null);

  // Issue #178: open 中に外部から settings が更新されると useEffect が再発火して
  // ユーザー入力中の draft が消える事故があった。
  // 解決: open が false→true に変化したフレームでだけ initial を採り込み、
  // open=true のままでの initial 変化は無視する (draft は閉じるまでユーザー編集を保持)。
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setDraft(initial);
      setActiveSection('general');
      // 直前の保存フィードバックが残っていれば初期化 (handleApply が onClose 後に setSaved(false)
      // を省略したぶんを、再オープン時にここで戻す)
      setSaved(false);
    }
    wasOpenRef.current = open;
  }, [open, initial]);

  // カスタムエージェントが削除された結果、activeSection が迷子になったら 'general' に戻す
  useEffect(() => {
    if (!activeSection.startsWith('custom:')) return;
    const exists = (draft.customAgents ?? []).some(
      (a) => `custom:${a.id}` === activeSection
    );
    if (!exists) setActiveSection('general');
  }, [activeSection, draft.customAgents]);

  // unmount 時に保存フィードバックタイマーを必ずクリア。
  // 旧実装は handleApply 内の window.setTimeout を握っておらず、
  // 380ms 以内に外部から閉じられるとアンマウント済みコンポーネントへの setSaved(false) が走る。
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, []);

  // Issue #195: マウント直後にダイアログ内の最初の focusable に focus を移す。
  // 何もせず開くと focus は背景 (Canvas/FileTree) に残り、Tab で背後に抜ける起点になる。
  // setTimeout のマジックナンバーを避けるため requestAnimationFrame を使い、
  // 描画完了直後の最初のフレームで focus を移す。
  useEffect(() => {
    if (!open) return;
    const raf = window.requestAnimationFrame(() => {
      const root = dialogRef.current;
      if (!root) return;
      const target = root.querySelector<HTMLElement>(
        '[autofocus], button, [href], input, select, textarea, [contenteditable]:not([contenteditable="false"]), [tabindex]:not([tabindex="-1"])'
      );
      target?.focus();
    });
    return () => window.cancelAnimationFrame(raf);
  }, [open]);

  const { mounted, dataState, motion } = useSpringMount(open, 180);
  // 注意: 早期 return は「最後の hook の後ろ」に移動してある (このファイル末尾近くの
  // `if (!mounted) return null;`)。useSpringMount より下にもまだ useMemo / useRef / useEffect が
  // 並んでおり、ここで return すると mounted の値で hook 数が変わって "Rendered more hooks
  // than during the previous render" エラーになる (#220 系で再発)。

  const update = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
      setDraft((d) => ({ ...d, [key]: value }));
    },
    []
  );

  const handleApply = (): void => {
    // saved=true の状態で再度押されるのはボタンの disabled で防いでいるが、
    // 380ms 中に外部から閉じる操作が走ったあとに別経路でこの関数が呼ばれた場合の二重実行ガード。
    if (saved) return;
    // onApply が同期で throw する場合と async (Promise reject) の両方をハンドリングする。
    // 現状の SettingsModalProps では onApply は同期だが、将来 async 化されたときに
    // unhandled rejection を起こさないよう Promise.resolve でラップしてから .catch する (レビュー指摘)。
    const reportFailure = (err: unknown): void => {
      console.error('[settings] apply failed:', err);
      const isJaNow = draft.language === 'ja';
      showToast(
        isJaNow
          ? '設定の保存に失敗しました。詳細は開発者ツールのコンソールを確認してください。'
          : 'Failed to save settings. See the developer console for details.',
        { tone: 'error', duration: 6000 }
      );
    };
    let result: unknown;
    try {
      result = onApply(draft);
    } catch (err) {
      // 同期 throw のケース
      reportFailure(err);
      return;
    }
    // 戻り値が thenable なら reject も拾う。non-thenable (void) なら何もしない。
    if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
      Promise.resolve(result).catch(reportFailure);
    }
    // 保存ボタンを 380ms だけ ✓ 表示にしてから閉じる。
    // 「押した → 保存された → モーダルが消える」の因果が体感できるようにする (Linear / Vercel 風)。
    setSaved(true);
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      // setSaved(false) は呼ばない: onClose で親がアンマウントするので不要な再レンダーを生むだけ。
      // 再 open 時の saved リセットは wasOpenRef effect (上) に集約してあるのでここでは不要。
      onClose();
    }, 380);
  };

  // Issue #28: Reset は draft だけを DEFAULT_SETTINGS に戻す。
  // 永続化は Apply / Cancel のタイミングに揃える (footer の 2 ボタンと整合)。
  const handleReset = (): void => {
    setDraft({ ...DEFAULT_SETTINGS });
  };

  const isJa = draft.language === 'ja';
  const customAgents = draft.customAgents ?? [];

  // Phase 4-2: nav state (groupsRaw / groups / activeSection 同期) を hook 化
  const { groups } = useSettingsNav({ draft, navQuery, setActiveSection });

  // Phase 4-2: focus trap + Escape を hook 化
  const handleDialogKeyDown = useSettingsKeydown({ dialogRef, onClose });

  /** 新規カスタムエージェントを追加して編集画面へ遷移 */
  const addCustomAgent = (): void => {
    const id = `ca_${Math.random().toString(36).slice(2, 10)}`;
    const agent: AgentConfig = {
      id,
      name: isJa ? '新しいエージェント' : 'New agent',
      command: '',
      args: '',
      cwd: ''
    };
    const next = [...customAgents, agent];
    update('customAgents', next);
    setActiveSection(`custom:${id}`);
  };

  // すべての hook 呼び出しが終わった後でだけ早期 return する (Rules of Hooks)。
  // これより上の useSpringMount から `mounted` を受け取り、未マウントなら DOM を返さない。
  if (!mounted) return null;

  const renderSection = (id: SectionId): JSX.Element | null => {
    switch (id) {
      case 'general':
        return (
          <>
            <LanguageSection draft={draft} update={update} />
            <DensitySection draft={draft} update={update} />
            {onReplayOnboarding && (
              <div className="settings-shell__replay">
                <button
                  type="button"
                  className="toolbar__btn settings-shell__replay-btn"
                  onClick={() => {
                    onClose();
                    onReplayOnboarding();
                  }}
                >
                  {t('onboarding.replay')}
                </button>
              </div>
            )}
          </>
        );
      case 'appearance':
        return (
          <>
            <ThemeSection draft={draft} update={update} />
            <MascotSection draft={draft} update={update} />
          </>
        );
      case 'fonts':
        return (
          <>
            <FontFamilySection
              title={isJa ? 'UI フォント' : 'UI Font'}
              familyKey="uiFontFamily"
              sizeKey="uiFontSize"
              presets={UI_FONT_PRESETS}
              draft={draft}
              update={update}
            />
            <FontFamilySection
              title={isJa ? 'エディタフォント (Monaco)' : 'Editor Font (Monaco)'}
              familyKey="editorFontFamily"
              sizeKey="editorFontSize"
              presets={EDITOR_FONT_PRESETS}
              draft={draft}
              update={update}
            />
            <TerminalSection draft={draft} update={update} />
          </>
        );
      case 'claude':
        return (
          <CommandOptionsSection
            title={isJa ? '起動オプション' : 'Launch options'}
            commandKey="claudeCommand"
            commandPlaceholder="claude"
            argsKey="claudeArgs"
            argsLabel={isJa ? '引数（空白区切り、ダブルクォートで空白を含む値）' : 'Arguments'}
            argsPlaceholder='--model opus --add-dir "D:/other project"'
            cwdKey="claudeCwd"
            cwdLabel={isJa ? '作業ディレクトリ（空なら現在のプロジェクトルート）' : 'Working directory'}
            cwdPlaceholder={isJa ? '（未設定）' : '(unset)'}
            note={
              isJa
                ? '変更後は再起動でターミナルに反映されます。'
                : 'Restart terminals to apply changes.'
            }
            draft={draft}
            update={update}
          />
        );
      case 'codex':
        return (
          <CommandOptionsSection
            title={isJa ? '起動オプション' : 'Launch options'}
            commandKey="codexCommand"
            commandPlaceholder="codex"
            argsKey="codexArgs"
            argsLabel={isJa ? '引数（空白区切り）' : 'Arguments'}
            argsPlaceholder="--model o3"
            draft={draft}
            update={update}
          />
        );
      case 'roles':
        return <RoleProfilesSection />;
      case 'mcp':
        return <McpSection draft={draft} update={update} />;
      case 'logs':
        return <LogsSection />;
      default:
        if (id.startsWith('custom:')) {
          const a = customAgents.find((x) => `custom:${x.id}` === id);
          if (!a) return null;
          return <CustomAgentEditor agent={a} draft={draft} update={update} />;
        }
        return null;
    }
  };

  const current = labelOf(activeSection, isJa, customAgents);

  return (
    <div
      className="modal-backdrop"
      data-state={dataState}
      data-motion={motion}
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        className="modal modal--settings"
        data-state={dataState}
        data-motion={motion}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={isJa ? '設定' : 'Settings'}
        // Issue #195: dialog root を programmatic focus ターゲットにするため tabindex=-1。
        // Escape を入力フィールドから受けたとき、まず root に focus を退避してから次の
        // Escape で閉じる UX (vscode / macOS native と同じ) を実現する。
        tabIndex={-1}
        onKeyDown={handleDialogKeyDown}
      >
        <header className="modal__header">
          <div className="modal__title-group">
            <button
              type="button"
              className="settings-back-btn"
              onClick={onClose}
              aria-label={isJa ? '戻る' : 'Back'}
              title={isJa ? '戻る' : 'Back'}
            >
              <ArrowLeft size={16} strokeWidth={2} />
            </button>
            <h2>{t('settings.title')}</h2>
          </div>
        </header>

        <div className="modal__body modal__body--settings">
          <nav className="settings-shell__nav" aria-label="Settings sections">
            <div className="settings-shell__search">
              <Search size={13} strokeWidth={2} className="settings-shell__search-icon" />
              <input
                type="text"
                className="settings-shell__search-input"
                placeholder={isJa ? '設定を検索…' : 'Search settings…'}
                value={navQuery}
                onChange={(e) => setNavQuery(e.target.value)}
                aria-label={isJa ? '設定を検索' : 'Search settings'}
              />
              {navQuery && (
                <button
                  type="button"
                  className="settings-shell__search-clear"
                  onClick={() => setNavQuery('')}
                  aria-label={isJa ? 'クリア' : 'Clear'}
                >
                  <X size={12} strokeWidth={2.2} />
                </button>
              )}
            </div>
            <div className="settings-shell__nav-list">
              {groups.length === 0 ? (
                <div className="settings-shell__nav-empty">
                  {isJa ? '一致する項目がありません' : 'No matches'}
                </div>
              ) : (
                groups.map((g, gi) => (
                  <div key={gi} style={{ display: 'contents' }}>
                    {g.label && (
                      <div className="settings-shell__nav-group-label">{g.label}</div>
                    )}
                    {g.items.map((id) => {
                      // 擬似項目: カスタムエージェント追加ボタン
                      if (id === '__addCustom') {
                        return (
                          <button
                            key={id}
                            type="button"
                            className="settings-shell__nav-item settings-shell__nav-item--add"
                            onClick={addCustomAgent}
                          >
                            <Plus size={13} strokeWidth={2} />
                            <span className="settings-shell__nav-label">
                              {t('settings.customAgents.add')}
                            </span>
                          </button>
                        );
                      }
                      const { label } = labelOf(id, isJa, customAgents);
                      const active = id === activeSection;
                      return (
                        <button
                          key={id}
                          type="button"
                          className={`settings-shell__nav-item${active ? ' is-active' : ''}`}
                          onClick={() => setActiveSection(id)}
                        >
                          <span className="settings-shell__nav-icon" aria-hidden="true">
                            {iconFor(id)}
                          </span>
                          <span className="settings-shell__nav-label">{label}</span>
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>
          </nav>

          <div className="settings-shell__content">
            <div>
              <h2 className="settings-shell__pane-title">{current.title}</h2>
              <p className="settings-shell__pane-desc">{current.desc}</p>
            </div>
            <div key={activeSection} className="settings-shell__panel">
              {renderSection(activeSection)}
            </div>
          </div>
        </div>

        <footer className="modal__footer">
          <button
            type="button"
            className="toolbar__btn settings-shell__reset"
            onClick={handleReset}
          >
            {t('settings.reset')}
          </button>
          <div className="modal__footer-right">
            <button type="button" className="toolbar__btn" onClick={onClose}>
              {t('settings.cancel')}
            </button>
            <button
              type="button"
              className={`toolbar__btn toolbar__btn--primary settings-shell__apply${
                saved ? ' is-saved' : ''
              }`}
              onClick={handleApply}
              disabled={saved}
              aria-label={t('settings.apply')}
            >
              {saved ? (
                <Check size={14} strokeWidth={2.5} />
              ) : (
                t('settings.apply')
              )}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
