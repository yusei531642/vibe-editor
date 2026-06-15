// api_agents/tools_web — web_fetch tool (Issue #1053, Codex web 相当)。
//
// 公開 URL の内容を取得して返す。autonomous エージェントがドキュメント/ページを参照できる。
// security: SSRF を防ぐため host を resolve し loopback/private/link-local 等に解決される host は
// 拒否する (ローカル AI が localhost で動くため特に重要)。本文は逐次 chunk で読み上限で truncate。
//
// 露出は auto 経路のみ。async (HTTP) なので bash と同じ async dispatch で実行する。

use serde_json::{json, Value};
use std::net::IpAddr;
use std::time::Duration;

use super::tools::{ToolOutcome, ToolSpec};

/// web_fetch が返す本文の最大バイト数 (既定 / 上限)。
const MAX_FETCH_BYTES: usize = 128 * 1024;
/// HTTP リクエストのタイムアウト。
const FETCH_TIMEOUT_SECS: u64 = 20;
/// 自前で辿るリダイレクトの最大ホップ数。
const MAX_REDIRECTS: usize = 5;

/// redirect を自動追従しない専用クライアント。リダイレクト先も毎回 SSRF 検証するため、
/// reqwest の自動 follow (redirect 経由の内部アクセス) を無効化する。
static NO_REDIRECT_CLIENT: once_cell::sync::Lazy<reqwest::Client> =
    once_cell::sync::Lazy::new(|| {
        reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_else(|_| reqwest::Client::new())
    });

fn ok(content: impl Into<String>) -> ToolOutcome {
    ToolOutcome { content: content.into(), is_error: false }
}
fn err(content: impl Into<String>) -> ToolOutcome {
    ToolOutcome { content: content.into(), is_error: true }
}

/// web 系 tool 名か (async dispatch)。
pub(super) fn is_web_tool(name: &str) -> bool {
    name == "web_fetch"
}

/// auto 経路で公開する web tool 定義。
pub(super) fn builtin_web_tools() -> Vec<ToolSpec> {
    vec![ToolSpec {
        name: "web_fetch",
        description: "Fetch the contents of a public http(s) URL (read-only). \
            Returns the HTTP status and body text, truncated to 128KB. \
            Private/loopback/internal hosts are blocked for security.",
        parameters: json!({
            "type": "object",
            "properties": {
                "url": { "type": "string", "description": "Absolute http(s) URL to fetch." },
                "max_bytes": { "type": "integer", "description": "Max body bytes to return (default/cap 131072)." }
            },
            "required": ["url"]
        }),
    }]
}

/// web 系 tool を実行する (async)。
pub(super) async fn execute_web_tool(name: &str, args: &Value) -> ToolOutcome {
    match name {
        "web_fetch" => web_fetch(args).await,
        other => err(format!("unknown web tool: {other}")),
    }
}

/// SSRF ガード: 内部 / 予約レンジに解決される IP を拒否する。
fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_unspecified()
                || v4.is_broadcast()
                || v4.is_documentation()
                // 100.64.0.0/10 (CGNAT)
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 0x40)
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || v6.is_unspecified()
                || (v6.segments()[0] & 0xfe00) == 0xfc00 // unique local fc00::/7
                || (v6.segments()[0] & 0xffc0) == 0xfe80 // link local fe80::/10
                || v6.to_ipv4_mapped().map(IpAddr::V4).map(is_blocked_ip).unwrap_or(false)
        }
    }
}

async fn web_fetch(args: &Value) -> ToolOutcome {
    let Some(url_str) = args.get("url").and_then(Value::as_str) else {
        return err("web_fetch requires a string 'url' argument");
    };
    let mut url = match reqwest::Url::parse(url_str.trim()) {
        Ok(u) => u,
        Err(e) => return err(format!("invalid url: {e}")),
    };
    let max = args
        .get("max_bytes")
        .and_then(Value::as_u64)
        .map(|n| (n as usize).min(MAX_FETCH_BYTES))
        .unwrap_or(MAX_FETCH_BYTES)
        .max(1);

    // redirect を自前で辿り、各ホップで SSRF 検証する (redirect 経由の内部アクセスを塞ぐ)。
    for _hop in 0..=MAX_REDIRECTS {
        if let Err(e) = validate_url_host(&url).await {
            return err(e);
        }
        let mut resp = match NO_REDIRECT_CLIENT
            .get(url.clone())
            .header("user-agent", "vibe-editor-agent")
            .timeout(Duration::from_secs(FETCH_TIMEOUT_SECS))
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => return err(format!("request failed: {e}")),
        };
        let status = resp.status();
        if status.is_redirection() {
            let Some(loc) = resp
                .headers()
                .get(reqwest::header::LOCATION)
                .and_then(|v| v.to_str().ok())
            else {
                return err(format!("HTTP {status}: redirect without a Location header"));
            };
            url = match url.join(loc) {
                Ok(u) => u,
                Err(e) => return err(format!("invalid redirect target: {e}")),
            };
            continue;
        }
        // 非リダイレクト: 本文を逐次 chunk で読み上限で打ち切る (メモリ保護)。
        let mut buf: Vec<u8> = Vec::new();
        let mut truncated = false;
        loop {
            match resp.chunk().await {
                Ok(Some(chunk)) => {
                    buf.extend_from_slice(&chunk);
                    if buf.len() >= max {
                        buf.truncate(max);
                        truncated = true;
                        break;
                    }
                }
                Ok(None) => break,
                Err(e) => return err(format!("read failed: {e}")),
            }
        }
        let mut text = format!("HTTP {status}\n\n{}", String::from_utf8_lossy(&buf));
        if truncated {
            text.push_str("\n…(truncated; exceeds size limit)");
        }
        return ok(text);
    }
    err("too many redirects")
}

/// scheme + host を検証する。host が内部 (loopback/private/...) に解決されるなら拒否。
/// redirect の各ホップで呼び、redirect 経由の SSRF を防ぐ。
async fn validate_url_host(url: &reqwest::Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only http/https URLs are allowed".to_string());
    }
    let Some(host) = url.host_str() else {
        return Err("url has no host".to_string());
    };
    let port = url.port_or_known_default().unwrap_or(443);
    let addrs = tokio::net::lookup_host((host, port))
        .await
        .map_err(|e| format!("could not resolve host: {e}"))?
        .collect::<Vec<_>>();
    if addrs.is_empty() {
        return Err("could not resolve host".to_string());
    }
    if addrs.iter().any(|a| is_blocked_ip(a.ip())) {
        return Err("blocked: host resolves to a private/loopback/internal address".to_string());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{Ipv4Addr, Ipv6Addr};

    #[test]
    fn is_web_tool_recognizes_name() {
        assert!(is_web_tool("web_fetch"));
        assert!(!is_web_tool("read_file"));
        let names: Vec<&str> = builtin_web_tools().iter().map(|s| s.name).collect();
        assert_eq!(names, vec!["web_fetch"]);
    }

    #[test]
    fn blocks_internal_ips() {
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(127, 0, 0, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(10, 0, 0, 5))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(169, 254, 1, 1))));
        assert!(is_blocked_ip(IpAddr::V4(Ipv4Addr::new(100, 64, 0, 1)))); // CGNAT
        assert!(is_blocked_ip(IpAddr::V6(Ipv6Addr::LOCALHOST)));
        // 公開 IP は許可
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(1, 1, 1, 1))));
        assert!(!is_blocked_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
    }

    #[tokio::test]
    async fn rejects_non_http_scheme() {
        let out = execute_web_tool("web_fetch", &json!({ "url": "ftp://example.com/x" })).await;
        assert!(out.is_error);
        assert!(out.content.contains("http/https"));
    }

    #[tokio::test]
    async fn rejects_invalid_url() {
        let out = execute_web_tool("web_fetch", &json!({ "url": "not a url" })).await;
        assert!(out.is_error);
        assert!(out.content.contains("invalid url"));
    }

    #[tokio::test]
    async fn blocks_loopback_literal_host() {
        let out = execute_web_tool("web_fetch", &json!({ "url": "http://127.0.0.1:1/" })).await;
        assert!(out.is_error);
        assert!(out.content.contains("blocked"));
    }

    #[tokio::test]
    async fn requires_url_arg() {
        let out = execute_web_tool("web_fetch", &json!({})).await;
        assert!(out.is_error);
    }
}
