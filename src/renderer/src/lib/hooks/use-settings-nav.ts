import { useEffect, useMemo, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AppSettings } from '../../../../types/shared';
import { useT } from '../i18n';
import { FIXED_SECTION_IDS, type SectionId } from '../settings-section-meta';

export interface SettingsNavGroup {
  label: string | null;
  items: SectionId[];
}

export interface UseSettingsNavOptions {
  draft: AppSettings;
  navQuery: string;
  // activeSection は受け取らない: 同期 effect 内で setActiveSection((prev) => ...) の
  // 関数型更新を使うため最新値は state 側から直接読む。caller 側で activeSection を別途
  // useState で持つ前提に変更はない。
  setActiveSection: Dispatch<SetStateAction<SectionId>>;
}

export interface UseSettingsNavResult {
  groupsRaw: SettingsNavGroup[];
  groups: SettingsNavGroup[];
}

/** Settings dialog のサイドバー nav state を扱う hook。
 *  - groupsRaw: 言語切替 / customAgents 変化に追従する固定グループ構造
 *  - groups: navQuery で絞り込んだ表示用グループ
 *  - activeSection 同期: 検索クエリが変わった瞬間に表示と選択状態を整合
 *
 *  Issue #729: 旧実装の isJa / FIXED_LABELS_JA/EN への直接依存を撤去し、
 *  i18n.ts の t() 経由でグループラベルとセクションラベルを解決するようにした。
 */
export function useSettingsNav(opts: UseSettingsNavOptions): UseSettingsNavResult {
  const { draft, navQuery, setActiveSection } = opts;
  const t = useT();

  // groupsRaw は customAgents と言語から導出される。useMemo で安定化させる。
  // deps には `customAgents` ローカル (`draft.customAgents ?? []`) ではなく `draft.customAgents` を
  // 直接入れる。`?? []` は undefined のとき毎レンダー新しい [] を返してしまい、参照比較で常に
  // 不一致 → メモ化が無効化される。`draft.customAgents` 自体は同一更新内では安定。
  const groupsRaw = useMemo<SettingsNavGroup[]>(
    () => {
      const agents = draft.customAgents ?? [];
      return [
        { label: null, items: ['general', 'appearance', 'fonts'] },
        {
          label: t('settings.section.group.agents'),
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
        { label: t('settings.section.group.team'), items: ['roles', 'mcp'] },
        // Issue #326: 「その他」グループにログビューアを置く。リリース後の bug 報告で
        // 開発者ツールを開かずにユーザー側でエラーログを確認できるようにする。
        { label: t('settings.section.group.other'), items: ['logs'] }
      ];
    },
    // 言語切替は t の参照同一性が変わる useT() の中で吸収されるが、useMemo 側に明示的な
    // deps として draft.language を入れて、言語切替で再評価が起きることを読みやすく保つ。
    [draft.customAgents, draft.language, t]
  );

  // 検索ワードで items を絞り込む。`__addCustom` は検索中だけ非表示 (新規追加は通常時のみ)。
  // 検索結果が空のグループはラベルごと除外する。
  // 旧実装は FIXED_LABELS_JA/EN テーブルを参照していたが、t() 経由に揃える。
  const groups = useMemo(() => {
    const q = navQuery.trim().toLowerCase();
    if (!q) return groupsRaw;
    const agents = draft.customAgents ?? [];
    const customLabelMap = new Map(agents.map((a) => [a.id, a.name] as const));
    const labelForFilter = (id: SectionId): string => {
      if ((FIXED_SECTION_IDS as readonly string[]).includes(id)) {
        return t(`settings.section.${id}.label`);
      }
      if (id.startsWith('custom:')) {
        const aid = id.slice('custom:'.length);
        return customLabelMap.get(aid) || t('settings.section.untitled');
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
  }, [navQuery, groupsRaw, draft.customAgents, draft.language, t]);

  // 検索フィルタ後の groups に activeSection が含まれない場合、右ペインとサイドバーの
  // 選択状態が乖離する (例: "font" 検索で nav は fonts だけ表示するのに右ペインは general のまま)。
  // → クエリが変わった瞬間に整合チェックする。
  //
  // 旧コードは deps に groups を入れていたが、検索中に customAgents が増減すると groups が
  // 変わって意図せず activeSection が先頭にリセットされる edge case があった。
  // → 同期は navQuery 変化時のみに限定し、groups は ref 経由で最新値を読む。
  // 関数型更新で activeSection 自身を比較することで再レンダーループも防ぐ。
  //
  // クリア時 (navQuery="") の挙動: フィルタ前の groupsRaw に activeSection が含まれていれば
  // そのまま維持、含まれていない (異常系) のみ先頭に戻す。これで「検索したまま放置 → クリア」
  // の流れで activeSection がフィルタ中の先頭に張り付く問題 (レビュー指摘) を解消する。
  const groupsRef = useRef(groups);
  groupsRef.current = groups;
  const groupsRawRef = useRef(groupsRaw);
  groupsRawRef.current = groupsRaw;
  useEffect(() => {
    const source = navQuery.trim() ? groupsRef.current : groupsRawRef.current;
    const flat: SectionId[] = source
      .flatMap((g) => g.items)
      .filter((id) => id !== '__addCustom');
    if (flat.length === 0) return;
    setActiveSection((prev) => (flat.includes(prev) ? prev : flat[0]));
  }, [navQuery, setActiveSection]);

  return { groupsRaw, groups };
}
