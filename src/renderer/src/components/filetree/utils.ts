import type { CSSProperties } from 'react';

/** Issue #592: 親ディレクトリの entries にぶつからない basename を作る。
 *  `foo.txt` → 衝突したら `foo.copy.txt` → `foo.copy 2.txt` → `foo.copy 3.txt` …
 *  拡張子無しなら末尾に `.copy` を付けるだけ。先頭ドットファイル (.gitignore 等) は
 *  拡張子と見なさない。 */
export function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  const dotIdx = base.lastIndexOf('.');
  const hasExt = dotIdx > 0;
  const stem = hasExt ? base.slice(0, dotIdx) : base;
  const ext = hasExt ? base.slice(dotIdx) : '';
  for (let n = 1; n < 1000; n += 1) {
    const suffix = n === 1 ? '.copy' : `.copy ${n}`;
    const candidate = `${stem}${suffix}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  // 1000 回衝突は事実上ありえないが、無限ループを避けるため timestamp を足す
  return `${stem}.copy.${Date.now()}${ext}`;
}

/** parent 相対パスを basename と join する (POSIX 区切り)。 */
export function joinRel(parent: string, name: string): string {
  if (!parent) return name;
  return `${parent.replace(/\/$/, '')}/${name}`;
}

/** 相対パスから親ディレクトリ部分 (POSIX) を取り出す。`a/b/c` → `a/b`、`a` → ''。 */
export function parentOfRel(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx >= 0 ? relPath.slice(0, idx) : '';
}

/** 相対パスから basename を取り出す。 */
export function basenameOfRel(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx >= 0 ? relPath.slice(idx + 1) : relPath;
}

export const shortName = (abs: string): string => {
  const parts = abs.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || abs;
};

export function fileTreeGuideStyle(depth: number): CSSProperties {
  return depth > 0
    ? {
        paddingLeft: 4 + depth * 12,
        backgroundImage:
          'repeating-linear-gradient(to right, var(--filetree-guide, rgba(127,127,127,0.16)) 0 1px, transparent 1px 12px)',
        backgroundSize: `${depth * 12}px 100%`,
        backgroundRepeat: 'no-repeat',
        backgroundPosition: '4px 0'
      }
    : { paddingLeft: 4 };
}
