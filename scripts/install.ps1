[CmdletBinding()]
param(
    [string]$WorkBuddyHome = (Join-Path $env:USERPROFILE '.workbuddy'),
    [string]$NodePath,
    [switch]$Uninstall
)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path -LiteralPath $WorkBuddyHome -PathType Container)) { throw 'WorkBuddy 数据目录不存在，请先启动应用或用 -WorkBuddyHome 指定。' }
$WorkBuddyHome = (Resolve-Path -LiteralPath $WorkBuddyHome).Path
$target = [IO.Path]::GetFullPath((Join-Path $WorkBuddyHome 'skills\codex-handoff'))
if (-not $target.StartsWith($WorkBuddyHome.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw '目标路径必须位于指定 WorkBuddy 目录内。' }
foreach ($entry in @((Join-Path $WorkBuddyHome 'skills'), $target, (Join-Path $WorkBuddyHome 'codex-handoff-backups'))) {
    if ((Test-Path -LiteralPath $entry) -and ((Get-Item -LiteralPath $entry -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw '安装位置包含链接或联接目录，请使用实际目录。' }
}
$backup = $null
if (-not $Uninstall) {
    if (-not $NodePath) { $NodePath = (Get-Command node -ErrorAction Stop).Source }
    $NodePath = (Resolve-Path -LiteralPath $NodePath).Path
    $major = & $NodePath -p 'process.versions.node.split(".")[0]'
    if ($LASTEXITCODE -ne 0 -or [int]$major -lt 24) { throw '需要已有的 Node.js 24+；可通过 -NodePath 指定，不会自动安装。' }
}
# Back up only this skill, never modify settings, login or other plugins.
if (Test-Path -LiteralPath $target) {
    $backupRoot = Join-Path $WorkBuddyHome 'codex-handoff-backups'
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $backup = Join-Path $backupRoot ((Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    Move-Item -LiteralPath $target -Destination $backup
    Write-Output "原技能已移至备份：$backup"
}
if ($Uninstall) { Write-Output '已移除本技能；备份和用户提取资料保留，未改其他设置。'; exit 0 }
$source = Join-Path $repo 'skills\codex-handoff'
New-Item -ItemType Directory -Path $target -Force | Out-Null
try {
    # Explicit release allowlist: no .git, fixtures, user data or build outputs.
    Copy-Item -LiteralPath (Join-Path $source 'SKILL.md') -Destination $target
    New-Item -ItemType Directory -Path (Join-Path $target 'scripts') | Out-Null
    Copy-Item -LiteralPath (Join-Path $source 'scripts\handoff.mjs') -Destination (Join-Path $target 'scripts')
    $runtime = @{ node = $NodePath; version = '0.1.0' } | ConvertTo-Json
    [IO.File]::WriteAllText((Join-Path $target 'runtime.json'), $runtime, [Text.UTF8Encoding]::new($false))
    foreach ($name in @('SKILL.md', 'scripts\handoff.mjs')) {
        if ((Get-FileHash -LiteralPath (Join-Path $source $name)).Hash -ne (Get-FileHash -LiteralPath (Join-Path $target $name)).Hash) { throw "复制校验失败：$name" }
    }
    & $NodePath (Join-Path $target 'scripts\handoff.mjs') help
    if ($LASTEXITCODE -ne 0) { throw '安装入口验证失败。' }
} catch {
    # Preserve the failed copy for inspection; restore the previous skill if present.
    $failed = "$target.failed-$([guid]::NewGuid().ToString('N'))"
    Move-Item -LiteralPath $target -Destination $failed
    if ($backup) { Copy-Item -LiteralPath $backup -Destination $target -Recurse }
    throw
}
Write-Output "安装完成：$target"
Write-Output '在 WorkBuddy 新建对话，输入“使用 codex-handoff，列出 Codex 聊天供我选择”。必要时重新启动 WorkBuddy。'
