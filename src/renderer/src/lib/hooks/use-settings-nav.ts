import { useEffect, useMemo, useRef } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { AppSettings } from '../../../../types/shared';
import {
  FIXED_LABELS_JA,
  FIXED_LABELS_EN,
  UNTITLED_FALLBACK_JA,
  UNTITLED_FALLBACK_EN,
  type SectionId
} from '../settings-section-meta';

export interface SettingsNavGroup {
  label: string | null;
  items: SectionId[];
}

export interface UseSettingsNavOptions {
  draft: AppSettings;
  navQuery: string;
  activeSection: SectionId;
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
 *  元 SettingsModal.tsx の groupsRaw / groups / 同期 effect を bit identical で hook 化。
 */
export function useSettingsNav(opts: UseSettingsNavOptions): UseSettingsNavResult {
  const { draft, navQuery, setActiveSection } = opts;
  const isJa = draft.language === 'ja';

  // groupsRaw は customAgents と isJa から導出される。useMemo で安定化させる。
  // deps には `customAgents` ローカル (`draft.customAgents ?? []`) ではなく `draft.customAgents` を
  // 直接入れる。`?? []` は undefined のとき毎レンダー新しい [] を返してしまい、参照比較で常に
  // 不一致 → メモ化が無効化される。`draft.customAgents` 自体は同一更新内では安定。
  const groupsRaw = useMemo<SettingsNavGroup[]>(
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
        { label: isJa ? 'チーム' : 'Team', items: ['roles', 'mcp'] },
        // Issue #326: 「その他」グループにログビューアを置く。リリース後の bug 報告で
        // 開発者ツールを開かずにユーザー側でエラーログを確認できるようにする。
        { label: isJa ? 'その他' : 'Other', items: ['logs'] }
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
    const fixedLabelMap = isJa ? FIXED_LABELS_JA : FIXED_LABELS_EN;
    const agents = draft.customAgents ?? [];
    const customLabelMap = new Map(agents.map((a) => [a.id, a.name] as const));
    // fixedLabels と untitled fallback は draft.language で同期して切り替わるため、
    // どちらかを deps に入れれば言語切替を検知できる。closure から isJa を直接参照しないことで
    // eslint exhaustive-deps 違反を解消する (レビュー指摘)。
    const untitled =
      fixedLabelMap === FIXED_LABELS_JA ? UNTITLED_FALLBACK_JA : UNTITLED_FALLBACK_EN;
    const labelForFilter = (id: SectionId): string => {
      if (fixedLabelMap[id]) return fixedLabelMap[id].label;
      if (id.startsWith('custom:')) {
        const aid = id.slice('custom:'.length);
        return customLabelMap.get(aid) || untitled;
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
    // deps 構成: navQuery / groupsRaw / draft.language。
    // 旧実装は fixedLabels (派生) を deps に入れていたが、groupsRaw のほうは
    // [draft.customAgents, draft.language] という生プロパティ参照になっていて非対称だった (レビュー指摘)。
    // → 言語切替を検知する deps を draft.language に統一して、両 useMemo の deps スタイルを揃える。
    // closure 内の fixedLabels / untitled は draft.language が変わると再評価されるので問題ない。
  }, [navQuery, groupsRaw, draft.language]);

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
