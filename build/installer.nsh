; vibe-editor NSIS カスタムスクリプト
;
; electron-builder の oneClick インストーラに対して、表示メッセージと
; フック先の軽いカスタマイズを行う。サードパーティプラグインには依存しない。
; 多言語対応は package.json 側の multiLanguageInstaller / language に任せる。

!define PRODUCT_NAME_PRETTY "vibe-editor"

; MUI テキスト（oneClick でも .exe のプロパティやサマリに反映される）
!define MUI_TEXT_WELCOME_INFO_TITLE "${PRODUCT_NAME_PRETTY} セットアップへようこそ"
!define MUI_TEXT_WELCOME_INFO_TEXT "vibe coding のための軽量 Claude Code / Codex エディタです。"
!define MUI_TEXT_FINISH_INFO_TITLE "${PRODUCT_NAME_PRETTY} のセットアップが完了しました"
!define MUI_TEXT_FINISH_INFO_TEXT "[完了] を押すと ${PRODUCT_NAME_PRETTY} が起動します。"
!define MUI_TEXT_ABORT_TITLE "セットアップを中断"
!define MUI_TEXT_ABORT_SUBTITLE "${PRODUCT_NAME_PRETTY} のインストールが完了しませんでした。"

; インストール開始前のフック
!macro customInit
  DetailPrint "vibe-editor のインストールを開始します…"
!macroend

; ファイルコピー直前のフック（起動中プロセスは electron-builder 側の
; unpackerPromptContext が面倒を見るのでここでは何もしない）
!macro customInstall
  DetailPrint "vibe-editor を展開しています…"
!macroend

; アンインストール直前のフック
!macro customUnInstall
  DetailPrint "vibe-editor をアンインストールしています…"
!macroend
