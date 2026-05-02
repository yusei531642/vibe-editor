# vibe-team Skills Pack Installer (Windows)
$ErrorActionPreference = "Stop"

$dest = Join-Path $env:USERPROFILE ".claude\skills"
$skills = @(
    "vibe-shared-roles",
    "vibe-issue-planner",
    "vibe-autopilot-batch",
    "vibe-fortress-review",
    "vibe-fortress-implement"
)

Write-Host "vibe-team Skills Pack Installer" -ForegroundColor Cyan
Write-Host "Installing to: $dest" -ForegroundColor Gray

if (-not (Test-Path $dest)) {
    New-Item -ItemType Directory -Path $dest -Force | Out-Null
    Write-Host "Created: $dest"
}

foreach ($s in $skills) {
    $src = Join-Path $PSScriptRoot $s
    $target = Join-Path $dest $s
    if (Test-Path $target) {
        Write-Host "  Updating: $s" -ForegroundColor Yellow
        Remove-Item -Path $target -Recurse -Force
    } else {
        Write-Host "  Installing: $s" -ForegroundColor Green
    }
    Copy-Item -Path $src -Destination $target -Recurse -Force
}

Write-Host ""
Write-Host "Done! $($skills.Count) skills installed." -ForegroundColor Green
Write-Host "Restart Claude Code to load the new skills." -ForegroundColor Gray
