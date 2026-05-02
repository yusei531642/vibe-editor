//! `team_hub::protocol` の tools が共通で使う helper 関数 + その unit test。
//!
//! Issue #373 Phase 2 で `protocol.rs` から切り出し。

/// team_send / team_assign_task の宛先解決。
///
/// raw_to (`"leader"` / `"programmer"` / `"all"` / 個別 agent_id) を
/// `(agent_id, role)` 配列にマッピングする。読み取り側 (`message_is_for_me`)
/// は resolve 結果の SSOT を見る。
pub(super) fn resolve_targets(
    members: &[(String, String)],
    self_agent_id: &str,
    raw_to: &str,
    active_leader_agent_id: Option<&str>,
) -> Vec<(String, String)> {
    let to = raw_to.trim();
    if to.eq_ignore_ascii_case("leader") {
        if let Some(active) = active_leader_agent_id.filter(|v| !v.trim().is_empty()) {
            return members
                .iter()
                .filter(|(aid, _)| aid == active && aid != self_agent_id)
                .cloned()
                .collect();
        }
    }
    // "all" 判定はメンバー数に依らない定数なのでループ外で 1 度だけ計算する
    let is_all = to.eq_ignore_ascii_case("all");
    let mut out: Vec<(String, String)> = Vec::new();
    for (aid, role) in members {
        if aid == self_agent_id {
            continue;
        }
        if is_all || role.eq_ignore_ascii_case(to) || aid == to {
            out.push((aid.clone(), role.clone()));
        }
    }
    out
}

/// メッセージが reader の宛先か判定する (team_read で使用)。
///
/// resolved_recipient_ids が SSOT。raw `to` は `legacy_message_fallback`
/// feature が有効な staging hotfix のみ参照する。
pub(super) fn message_is_for_me(
    resolved_recipient_ids: &[String],
    raw_to: &str,
    reader_role: &str,
    reader_agent_id: &str,
) -> bool {
    if !resolved_recipient_ids.is_empty() {
        return resolved_recipient_ids
            .iter()
            .any(|aid| aid == reader_agent_id);
    }
    if cfg!(feature = "legacy_message_fallback") {
        let to_trim = raw_to.trim();
        return to_trim.eq_ignore_ascii_case("all")
            || to_trim.eq_ignore_ascii_case(reader_role)
            || to_trim == reader_agent_id;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::{message_is_for_me, resolve_targets};

    fn member(aid: &str, role: &str) -> (String, String) {
        (aid.to_string(), role.to_string())
    }

    fn ids(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    // ===== Issue #342 Phase 2: message_is_for_me / resolved_recipient_ids tests =====

    #[test]
    fn is_for_me_uses_resolved_ids_when_present() {
        // resolved_recipient_ids が SSOT。raw `to` が読み手 role と違っても、
        // 自分の agent_id が含まれていれば受信できる (identity 分離耐性)。
        let resolved = ids(&["vc-leader-1"]);
        // raw `to` は "team-lead" (送信時の role 名)、読み手 ctx は role="Leader"
        // (case 違い) かつ agent_id="vc-leader-1"。resolved を見るので true。
        assert!(message_is_for_me(&resolved, "team-lead", "Leader", "vc-leader-1"));
        // 読み手 agent_id が違えば自分宛てではない (broadcast でも resolved に居なければ false)。
        assert!(!message_is_for_me(&resolved, "team-lead", "Leader", "vc-other"));
    }

    #[test]
    fn is_for_me_two_receivers_with_same_role_both_match() {
        // 同 role 2 名がチームに居て team_send(to: "<role>") を打つと、
        // 送信時 resolve で 2 名の agent_id が resolved_recipient_ids に入る。
        // 両者の team_read が個別に true を返すこと (Phase 2 受け入れ基準)。
        let resolved = ids(&["vc-prog-1", "vc-prog-2"]);
        assert!(message_is_for_me(&resolved, "programmer", "programmer", "vc-prog-1"));
        assert!(message_is_for_me(&resolved, "programmer", "programmer", "vc-prog-2"));
        // 第三者 (別 role) は受信しない。
        assert!(!message_is_for_me(&resolved, "programmer", "reviewer", "vc-rev"));
    }

    #[test]
    fn is_for_me_silent_drop_when_resolved_empty_and_no_legacy() {
        // resolved が空 = 送信時に宛先 0 件 (例: 不明 role への送信、または未来の
        // legacy 残骸)。default features では無条件 false にして、`team_read` 0 件で
        // identity 分離を可視化する (旧実装の raw `to` 再解釈サイレント沈黙を回避)。
        // ※ legacy_message_fallback feature が立つと別 branch に入るため、この
        //   アサーションは default features 下でのみ意味を持つ。
        #[cfg(not(feature = "legacy_message_fallback"))]
        {
            let resolved: Vec<String> = vec![];
            assert!(!message_is_for_me(&resolved, "leader", "leader", "vc-leader"));
            assert!(!message_is_for_me(&resolved, "all", "leader", "vc-leader"));
            assert!(!message_is_for_me(&resolved, "vc-leader", "leader", "vc-leader"));
        }
    }

    #[cfg(feature = "legacy_message_fallback")]
    #[test]
    fn is_for_me_legacy_fallback_when_resolved_empty() {
        // legacy_message_fallback 有効時のみ、空 resolved に対して旧 raw `to`
        // 再解釈経路で受信できる (staging hotfix の安全弁)。
        let empty: Vec<String> = vec![];
        // role 名 case-insensitive
        assert!(message_is_for_me(&empty, "Leader", "leader", "vc-leader"));
        // "all" は全員に届く
        assert!(message_is_for_me(&empty, "ALL", "programmer", "vc-prog"));
        // agent_id 完全一致
        assert!(message_is_for_me(&empty, "vc-leader", "leader", "vc-leader"));
        // 関係ない role / agent_id は false
        assert!(!message_is_for_me(&empty, "reviewer", "leader", "vc-leader"));
    }

    #[test]
    fn is_for_me_resolved_present_overrides_legacy_path() {
        // resolved が非空のときは legacy_message_fallback の有無に関わらず
        // resolved だけを見る (raw `to` の再解釈は走らない)。
        let resolved = ids(&["vc-prog-1"]);
        // raw `to` は "all" だが resolved に自分が居ないので false。
        // (送信時に意図的に self を弾いた、または resolve_targets が一部だけ採用した想定)
        assert!(!message_is_for_me(&resolved, "all", "reviewer", "vc-rev"));
    }

    #[test]
    fn resolve_targets_matches_role_exact() {
        let members = vec![
            member("vc-leader", "leader"),
            member("vc-prog", "programmer"),
        ];
        let got = resolve_targets(&members, "vc-leader", "programmer", None);
        assert_eq!(got, vec![member("vc-prog", "programmer")]);
    }

    #[test]
    fn resolve_targets_matches_role_case_insensitive() {
        let members = vec![
            member("vc-leader", "leader"),
            member("vc-prog", "programmer"),
        ];
        // Claude が "Programmer" / "PROGRAMMER" で送ってきても届くこと
        let got = resolve_targets(&members, "vc-leader", "Programmer", None);
        assert_eq!(got, vec![member("vc-prog", "programmer")]);
        let got = resolve_targets(&members, "vc-leader", "PROGRAMMER", None);
        assert_eq!(got, vec![member("vc-prog", "programmer")]);
    }

    #[test]
    fn resolve_targets_trims_whitespace() {
        let members = vec![
            member("vc-leader", "leader"),
            member("vc-prog", "programmer"),
        ];
        // 呼び出し側で trim 済みである前提だが、resolve_targets 自体も trim する
        let got = resolve_targets(&members, "vc-leader", "  programmer  ", None);
        assert_eq!(got, vec![member("vc-prog", "programmer")]);
    }

    #[test]
    fn resolve_targets_matches_agent_id() {
        let members = vec![
            member("vc-leader", "leader"),
            member("vc-prog-1", "programmer"),
            member("vc-prog-2", "programmer"),
        ];
        // 同 role の複数メンバー中から agent_id で 1 名指定
        let got = resolve_targets(&members, "vc-leader", "vc-prog-2", None);
        assert_eq!(got, vec![member("vc-prog-2", "programmer")]);
    }

    #[test]
    fn resolve_targets_all_excludes_self() {
        let members = vec![
            member("vc-leader", "leader"),
            member("vc-prog", "programmer"),
            member("vc-rev", "reviewer"),
        ];
        let got = resolve_targets(&members, "vc-leader", "all", None);
        assert_eq!(got.len(), 2);
        assert!(got.iter().all(|(aid, _)| aid != "vc-leader"));
        // "ALL" でも通る
        let got = resolve_targets(&members, "vc-leader", "ALL", None);
        assert_eq!(got.len(), 2);
    }

    #[test]
    fn resolve_targets_no_self_reply() {
        let members = vec![
            member("vc-leader", "leader"),
            member("vc-prog", "programmer"),
        ];
        // 自分自身 (leader) を狙っても自分は含めない
        let got = resolve_targets(&members, "vc-leader", "leader", None);
        assert!(got.is_empty());
    }

    #[test]
    fn resolve_targets_unknown_role_empty() {
        let members = vec![
            member("vc-leader", "leader"),
            member("vc-prog", "programmer"),
        ];
        let got = resolve_targets(&members, "vc-leader", "researcher", None);
        assert!(got.is_empty());
    }
}
