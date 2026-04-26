import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bot,
  Check,
  Code2,
  Palette,
  Plug,
  Plus,
  Search,
  Settings as SettingsIcon,
  Sparkles,
  Type,
  Users,
  X
} from 'lucide-react';
import type { AgentConfig, AppSettings } from '../../../types/shared';
import { DEFAULT_SETTINGS } from '../../../types/shared';
import { useT } from '../lib/i18n';
import { useToast } from '../lib/toast-context';
import { useSpringMount } from '../lib/use-animated-mount';
import { EDITOR_FONT_PRESETS, UI_FONT_PRESETS } from '../lib/settings-options';
import { LanguageSection } from './settings/LanguageSection';
import { ThemeSection } from './settings/ThemeSection';
import { FontFamilySection } from './settings/FontFamilySection';
import { TerminalSection } from './settings/TerminalSection';
import { RoleProfilesSection } from './settings/RoleProfilesSection';
import { DensitySection } from './settings/DensitySection';
import { CommandOptionsSection } from './settings/CommandOptionsSection';
import { CustomAgentEditor } from './settings/CustomAgentEditor';
import { McpSection } from './settings/McpSection';

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

/**
 * SectionId はカスタムエージェント対応のため動的な文字列。
 * 固定セクション: 'general' | 'appearance' | 'fonts' | 'claude' | 'codex' | 'mcp'
 * カスタムエージェント: `custom:${agentId}`
 */
type SectionId = string;

/** セクション ID → サイドバー Lucide アイコン。
 *
 *  旧実装は JSX リテラルをモジュールスコープに保持していたが、これは
 *  React.StrictMode の二重レンダリングや React Server Components 移行時に
 *  「複数のレンダーが同一インスタンスを共有する」前提が崩れる懸念がある。
 *  → アイコンコンポーネント自体だけを参照し、props (size/strokeWidth) は
 *     共通定数として再利用、JSX は呼び出しごとに都度生成する形に統一する。
 *     パフォーマンスへの影響はこの規模では実測差が出ないため、安全側に倒す。 */
const ICON_PROPS = { size: 14, strokeWidth: 1.85 } as const;
const SECTION_ICON_TYPES: Record<string, React.ComponentType<typeof ICON_PROPS>> = {
  general: SettingsIcon,
  appearance: Palette,
  fonts: Type,
  claude: Bot,
  codex: Code2,
  roles: Users,
  mcp: Plug
};
function iconFor(id: SectionId): JSX.Element {
  const Icon =
    SECTION_ICON_TYPES[id] ??
    (id.startsWith('custom:') ? Sparkles : SECTION_ICON_TYPES.general);
  return <Icon {...ICON_PROPS} />;
}

/** 固定セクションのラベル / タイトル / 説明 (i18n)。
 *  毎レンダー新規オブジェクトを生成すると useMemo の deps チェーンが無効化されるため、
 *  ja / en それぞれをモジュールスコープで 1 度だけ作る。 */
type FixedLabelEntry = { label: string; title: string; desc: string };
const FIXED_LABELS_JA: Record<string, FixedLabelEntry> = {
  general: { label: '一般', title: '一般', desc: '言語と密度設定' },
  appearance: { label: '表示', title: '表示', desc: 'テーマと配色' },
  fonts: { label: 'フォント', title: 'フォント', desc: 'UI / エディタ / ターミナルのフォント' },
  claude: { label: 'Claude Code', title: 'Claude Code', desc: '起動コマンドと引数' },
  codex: { label: 'Codex', title: 'Codex', desc: '起動コマンドと引数' },
  roles: { label: 'ロール定義', title: 'ロール定義', desc: 'チームメンバーの役割テンプレ' },
  mcp: { label: 'MCP', title: 'MCP', desc: 'vibe-team MCP の導入方法' }
};
const FIXED_LABELS_EN: Record<string, FixedLabelEntry> = {
  general: { label: 'General', title: 'General', desc: 'Language and density' },
  appearance: { label: 'Appearance', title: 'Appearance', desc: 'Theme and surfaces' },
  fonts: { label: 'Fonts', title: 'Typography', desc: 'UI / editor / terminal fonts' },
  claude: { label: 'Claude Code', title: 'Claude Code', desc: 'Launch command and args' },
  codex: { label: 'Codex', title: 'Codex', desc: 'Launch command and args' },
  roles: { label: 'Role profiles', title: 'Role profiles', desc: 'Team member role templates' },
  mcp: { label: 'MCP', title: 'MCP', desc: 'How to install vibe-team MCP' }
};

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

  const { mounted, dataState, motion } = useSpringMount(open, 180);
  if (!mounted) return null;

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    setDraft((d) => ({ ...d, [key]: value }));
  };

  const handleApply = (): void => {
    // saved=true の状態で再度押されるのはボタンの disabled で防いでいるが、
    // 380ms 中に外部から閉じる操作が走ったあとに別経路でこの関数が呼ばれた場合の二重実行ガード。
    if (saved) return;
    // onApply が throw した場合に「保存された ✓」のフィードバックを見せて閉じてしまうと
    // ユーザーは保存に成功したと誤解する。例外を捕まえて、success path だけで saved=true に倒す。
    try {
      onApply(draft);
    } catch (err) {
      console.error('[settings] apply failed:', err);
      // toast でユーザーにも保存失敗を明示 (旧実装は console のみで UI 上は無音だった)。
      const detail = err instanceof Error ? err.message : String(err);
      const isJaNow = draft.language === 'ja';
      showToast(
        isJaNow ? `設定の保存に失敗しました: ${detail}` : `Failed to save settings: ${detail}`,
        { tone: 'error', duration: 6000 }
      );
      return; // saved=true / setTimeout を始動しないことで、モーダルを閉じない
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

  // 固定ラベルはモジュールスコープのため毎レンダーで参照が変わらない。
  // useMemo deps に直接入れても安定性を保てる。
  const fixedLabels = isJa ? FIXED_LABELS_JA : FIXED_LABELS_EN;

  /** 指定 id のラベル情報を返す (固定 + カスタム動的) */
  const labelOf = (id: SectionId): { label: string; title: string; desc: string } => {
    if (fixedLabels[id]) return fixedLabels[id];
    if (id.startsWith('custom:')) {
      const a = customAgents.find((x) => `custom:${x.id}` === id);
      const name = a?.name || (isJa ? '（無名）' : '(untitled)');
      return {
        label: name,
        title: name,
        desc: isJa ? 'カスタムエージェント設定' : 'Custom agent settings'
      };
    }
    if (id === '__addCustom') {
      return {
        label: isJa ? '+ 追加' : '+ Add',
        title: isJa ? '+ 追加' : '+ Add',
        desc: ''
      };
    }
    return { label: id, title: id, desc: '' };
  };

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

  // groupsRaw は customAgents と isJa から導出される。useMemo で安定化させる。
  // deps には `customAgents` ローカル (`draft.customAgents ?? []`) ではなく `draft.customAgents` を
  // 直接入れる。`?? []` は undefined のとき毎レンダー新しい [] を返してしまい、参照比較で常に
  // 不一致 → メモ化が無効化される。`draft.customAgents` 自体は同一更新内では安定。
  const groupsRaw = useMemo<
    Array<{ label: string | null; items: SectionId[] }>
  >(
    () => {
      const agents = draft.customAgents ?? [];
      return [
        { label: null, items: ['general', 'appearance', 'fonts'] },
        {
          label: isJa ? 'エージェント' : 'Agents',
          items: [
            'claude',
            'codex',
            ...agents.map((a) => `custom:${a.id}`),
            '__addCustom'
          ]
        },
        // vibe-team MCP のセットアップ手順は「チーム」機能の一部なので同グループに収める。
        // 旧構成では MCP を独立グループにしていたが、グループラベル "MCP" と唯一の項目 "MCP" が
        // 同名で並び、サイドバー上で MCP が 2 行重複しているように見える UI バグを生んでいた。
        { label: isJa ? 'チーム' : 'Team', items: ['roles', 'mcp'] }
      ];
    },
    // deps は customAgents と同じく draft の生プロパティを直接参照する形で統一する。
    // isJa は draft.language === 'ja' の派生 boolean で毎レンダー再評価されるため、
    // 意図を明確にするには元の draft.language を deps に入れる方が読みやすい (レビュー指摘)。
    [draft.customAgents, draft.language]
  );

  // 検索ワードで items を絞り込む。`__addCustom` は検索中だけ非表示 (新規追加は通常時のみ)。
  // 検索結果が空のグループはラベルごと除外する。
  // labelOf を closure で参照していた旧実装は eslint-disable で exhaustive-deps を抑制していたが、
  // 将来 labelOf が customAgents / isJa 以外の state も読むようになるとメモ化バグの種になる。
  // → 検索フィルタ用のラベル解決を useMemo 内にインライン化し、必要な依存を明示する。
  const groups = useMemo(() => {
    const q = navQuery.trim().toLowerCase();
    if (!q) return groupsRaw;
    const fixedLabelMap = fixedLabels;
    const agents = draft.customAgents ?? [];
    const customLabelMap = new Map(agents.map((a) => [a.id, a.name] as const));
    const labelForFilter = (id: SectionId): string => {
      if (fixedLabelMap[id]) return fixedLabelMap[id].label;
      if (id.startsWith('custom:')) {
        const aid = id.slice('custom:'.length);
        return customLabelMap.get(aid) || (isJa ? '（無名）' : '(untitled)');
      }
      return id;
    };
    return groupsRaw
      .map((g) => ({
        label: g.label,
        items: g.items.filter((id) => {
          if (id === '__addCustom') return false;
          const label = labelForFilter(id);
          return label.toLowerCase().includes(q) || id.toLowerCase().includes(q);
        })
      }))
      .filter((g) => g.items.length > 0);
    // 旧コードは fixedLabels と isJa の両方を deps に入れていたが、fixedLabels は
    // FIXED_LABELS_JA / _EN のモジュール定数を isJa で選んだだけなので isJa は冗長 (レビュー指摘)。
    // fixedLabels が変われば必然的に isJa も切り替わっており、`fixedLabels` だけで十分。
    // groupsRaw deps は draft.customAgents と draft.language をモジュールスコープ参照で
    // 拾うので isJa を抜くのと同様の理由で `draft.customAgents` を直接入れる。
  }, [navQuery, groupsRaw, fixedLabels, draft.customAgents]);

  // 検索フィルタ後の groups に activeSection が含まれない場合、右ペインとサイドバーの
  // 選択状態が乖離する (例: "font" 検索で nav は fonts だけ表示するのに右ペインは general のまま)。
  // → フィルタ結果の最初の項目に自動で切り替えて整合させる。検索クリア時は最後に選んだ
  //    項目を維持する (ユーザーが意図的にクリアした想定)。
  // deps から activeSection を外し、setActiveSection(prev => ...) の関数型更新で自分自身を読む。
  // (deps に入れると setActiveSection → 再レンダー → useEffect 再実行のループが理論上発生しうる)
  useEffect(() => {
    if (!navQuery.trim()) return;
    const flat: SectionId[] = groups
      .flatMap((g) => g.items)
      .filter((id) => id !== '__addCustom');
    if (flat.length === 0) return;
    setActiveSection((prev) => (flat.includes(prev) ? prev : flat[0]));
  }, [navQuery, groups]);

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
        return <ThemeSection draft={draft} update={update} />;
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
      default:
        if (id.startsWith('custom:')) {
          const a = customAgents.find((x) => `custom:${x.id}` === id);
          if (!a) return null;
          return <CustomAgentEditor agent={a} draft={draft} update={update} />;
        }
        return null;
    }
  };

  const current = labelOf(activeSection);

  return (
    <div
      className="modal-backdrop"
      data-state={dataState}
      data-motion={motion}
      onClick={onClose}
    >
      <div
        className="modal modal--settings"
        data-state={dataState}
        data-motion={motion}
        onClick={(e) => e.stopPropagation()}
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
                      const { label } = labelOf(id);
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
