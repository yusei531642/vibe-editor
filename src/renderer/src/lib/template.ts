/**
 * CLAUDE.md の最小テンプレート。
 * vibe coding 前提のため、人間が埋めるべきメタ情報のみ骨組みとして用意する。
 * 実際の内容は Claude Code が作業中に書き込むので、これは初期骨子にすぎない。
 */
export function claudeMdTemplate(projectName: string): string {
  return `# ${projectName}

## 概要
（プロジェクトの目的を1-2行で）

## 技術スタック
- （言語、フレームワーク、主要ライブラリ）

## コーディング規約
- （スタイル・規約があれば）

## よく使うコマンド
- 開発起動: \`npm run dev\`
- ビルド: \`npm run build\`
- テスト: \`npm test\`

## 注意事項
- （プロジェクト固有の注意点）
`;
}
