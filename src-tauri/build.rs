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
