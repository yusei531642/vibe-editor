#!/usr/bin/env bash
# 起票スクリプト: tasks/refactor-2026-05/issues/<wave>/*.md を順次起票する
#
# 使い方:
#   bash tasks/refactor-2026-05/create-issues.sh wave1     # Wave 1 (S+A 16件) を起票
#   bash tasks/refactor-2026-05/create-issues.sh wave2     # Wave 2 (B 15件) を起票
#   bash tasks/refactor-2026-05/create-issues.sh wave3     # Wave 3 (C 20件 + roadmap) を起票
#   bash tasks/refactor-2026-05/create-issues.sh all       # 全部
#
# 出力:
#   tasks/refactor-2026-05/created-issues.txt に「<id>\t<issue-number>\t<url>」形式で append
#
# 各 .md file の冒頭 2 行は機械読み取り用ヘッダ:
#   TITLE: <title>
#   LABELS: <comma-separated labels>
# その後にブランクライン + body。

set -euo pipefail

ROOT="F:/vive-editor"
ISSUES_DIR="$ROOT/tasks/refactor-2026-05/issues"
LOG_FILE="$ROOT/tasks/refactor-2026-05/created-issues.txt"

create_issue_from_file() {
  local file="$1"
  local id
  id=$(basename "$file" .md)

  # 既起票 check (idempotent)
  if [[ -f "$LOG_FILE" ]] && grep -q $'^'"$id"$'\t' "$LOG_FILE"; then
    echo "[skip] $id: already created (in $LOG_FILE)"
    return 0
  fi

  # title (1 行目)
  local title
  title=$(head -1 "$file" | sed 's/^TITLE: //')

  # labels (2 行目)
  local labels
  labels=$(sed -n '2p' "$file" | sed 's/^LABELS: //')

  # body (3 行目以降、ブランクライン考慮で 4 行目から)
  local body
  body=$(tail -n +3 "$file")

  echo "[create] $id: $title"
  echo "[create] labels: $labels"

  local url
  url=$(gh issue create \
    --title "$title" \
    --label "$labels" \
    --body "$body" 2>&1)

  if [[ "$url" =~ /issues/([0-9]+) ]]; then
    local number="${BASH_REMATCH[1]}"
    echo -e "$id\t$number\t$url" >> "$LOG_FILE"
    echo "[ok] #$number $url"
  else
    echo "[FAIL] $id: $url" >&2
    return 1
  fi

  # GitHub API rate-limit を避けるため 0.5s 待つ
  sleep 0.5
}

run_wave() {
  local wave="$1"
  local dir="$ISSUES_DIR/$wave"
  if [[ ! -d "$dir" ]]; then
    echo "Wave directory not found: $dir" >&2
    return 1
  fi

  echo "=== Starting $wave ==="
  echo "=== $wave $(date) ===" >> "$LOG_FILE"

  # ID を明示的な順序で起票 (S → A → B → C → D-roadmap)
  local ORDER=()
  case "$wave" in
    wave1)
      ORDER=(S-1 S-2 S-3 S-4 S-5 A-1 A-2 A-3 A-4 A-5 A-6 A-7 A-8 A-9 A-10 A-11)
      ;;
    wave2)
      ORDER=(B-1 B-2 B-3 B-4 B-5 B-6 B-7 B-8 B-9 B-10 B-11 B-12 B-13 B-14 B-15)
      ;;
    wave3)
      ORDER=(C-1 C-2 C-3 C-4 C-5 C-6 C-7 C-8 C-9 C-10 C-11 C-12 C-13 C-14 C-15 C-16 C-17 C-18 C-19 C-20 D-roadmap)
      ;;
  esac

  for id in "${ORDER[@]}"; do
    local file="$dir/$id.md"
    if [[ ! -f "$file" ]]; then
      echo "[skip] $id: file not found ($file)" >&2
      continue
    fi
    create_issue_from_file "$file"
  done

  echo "=== Done $wave (${#ORDER[@]} planned) ==="
}

main() {
  local target="${1:-all}"

  : > "$LOG_FILE.tmp" # ヘッダ確保
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "# created-issues log (TSV: <id>\t<number>\t<url>)" > "$LOG_FILE"
  fi

  case "$target" in
    wave1) run_wave wave1 ;;
    wave2) run_wave wave2 ;;
    wave3) run_wave wave3 ;;
    all)
      run_wave wave1
      run_wave wave2
      run_wave wave3
      ;;
    *)
      echo "Unknown target: $target (expected: wave1 | wave2 | wave3 | all)" >&2
      exit 1
      ;;
  esac

  echo
  echo "=== Summary ==="
  echo "Log: $LOG_FILE"
  tail -50 "$LOG_FILE"
}

main "$@"
