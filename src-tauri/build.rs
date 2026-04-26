// Tauri 側 build.rs。
//
// `tauri::generate_context!()` はコンパイル時に `frontendDist` (= ../dist) の存在を検証するため、
// クリーン checkout 直後で `npm run build:vite` が走っていない状態では `cargo check` や
// `cargo build` が macro 展開で失敗する (Issue #21)。
//
// 対策: dist/ が空 or 欠落していれば、最小限の placeholder index.html を作って macro 評価を通す。
// 本物のフロントは `beforeBuildCommand` (= npm run build:vite) / `beforeDevCommand` が上書きする。
fn main() {
    ensure_frontend_placeholder();
    // Windows: main thread の stack reserve をデフォルト 1 MB → 8 MB に引き上げる。
    // v1.4.0 で起動 ~3 秒後に "thread 'main' has overflowed its stack" で死ぬ事象が出た。
    // 同じソースの debug build では再現しないので、release プロファイル特有の deep inline /
    // LTO による stack frame 膨張で 1 MB を踏み越えていると判断 (tracing-subscriber 初期化 +
    // tauri::generate_handler! の dispatch + serde deserialize 連鎖が疑わしい)。
    // 根本原因の追跡は別 issue で行うが、当座のクラッシュ抑止としてリンカに /STACK を渡す。
    // 形式: /STACK:reserve[,commit]。reserve だけ指定すれば commit はそのまま (= 4 KiB)。
    #[cfg(target_os = "windows")]
    println!("cargo:rustc-link-arg-bins=/STACK:8388608");
    tauri_build::build();
}

fn ensure_frontend_placeholder() {
    use std::fs;
    use std::path::PathBuf;

    // src-tauri/ から 1 階層上の dist/
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let dist = manifest_dir
        .parent()
        .map(|p| p.join("dist"))
        .expect("parent of CARGO_MANIFEST_DIR must exist");

    let index_html = dist.join("index.html");
    if index_html.exists() {
        return;
    }

    if !dist.exists() {
        if let Err(e) = fs::create_dir_all(&dist) {
            println!("cargo:warning=failed to create dist/: {e}");
            return;
        }
    }

    let placeholder = "<!doctype html><meta charset=\"utf-8\"><title>vibe-editor</title>\
        <p>placeholder (run <code>npm run build:vite</code> for the real bundle)</p>";
    if let Err(e) = fs::write(&index_html, placeholder) {
        println!("cargo:warning=failed to write dist/index.html placeholder: {e}");
    } else {
        println!(
            "cargo:warning=created dist/index.html placeholder for clean-checkout cargo check"
        );
    }
}
