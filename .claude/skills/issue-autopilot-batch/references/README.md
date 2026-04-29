# references/

`issue-autopilot-batch` skill の reference 群は Google Drive に格納されている。
SKILL.md の「オンデマンドRead指示」テーブルに従い、必要な Step に到達したら
`mcp__*__read_file_content` で Drive から都度取得して使用する。

ローカルキャッシュとして取り込みたい場合は、SKILL.md のテーブルに記載された
fileId を使い `mcp__*__download_file_content` で base64 取得 → デコードして
このディレクトリに展開すること。

Drive folder: `13u16jHAJFXmc1-Cd6qJBkqZUUlq6-H2V`
