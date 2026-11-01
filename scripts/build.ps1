[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (& git -C $repo status --porcelain --untracked-files=no) { throw '请先提交已跟踪文件的改动，确保两个包来自同一版本。' }
$version = (Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
$out = Join-Path $repo 'artifacts'
New-Item -ItemType Directory -Path $out -Force | Out-Null
$sourceZip = Join-Path $out "workbuddy-codex-handoff-$version.zip"
$skillZip = Join-Path $out "codex-handoff-skill-$version.zip"
if ((Test-Path -LiteralPath $sourceZip) -or (Test-Path -LiteralPath $skillZip)) { throw '产物已存在，请移走旧产物后重新构建，避免覆盖。' }
& git -C $repo archive --format=zip --output=$sourceZip HEAD
if ($LASTEXITCODE -ne 0) { throw 'git archive 失败。请先提交本次发布内容。' }
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($skillZip, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($mapping in @(
        @('skills/codex-handoff/SKILL.md', 'SKILL.md'),
        @('skills/codex-handoff/scripts/handoff.mjs', 'scripts/handoff.mjs'),
        @('LICENSE', 'LICENSE')
    )) {
        & git -C $repo ls-files --error-unmatch -- $mapping[0] | Out-Null
        if ($LASTEXITCODE -ne 0) { throw "不允许打包未跟踪文件：$($mapping[0])" }
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $repo $mapping[0]), $mapping[1]) | Out-Null
    }
} finally { $zip.Dispose() }
$sums = @($sourceZip, $skillZip) | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant() + '  ' + [IO.Path]::GetFileName($_) }
[IO.File]::WriteAllLines((Join-Path $out 'SHA256SUMS'), $sums, [Text.UTF8Encoding]::new($false))
Write-Output "已构建 $sourceZip 和 $skillZip"
