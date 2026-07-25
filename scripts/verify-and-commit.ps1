param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Message
)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$fallbackBuildRoot = 'F:\Z huabu\知瑶画布\build-cache\verified-commits'
if (-not $env:CARGO_TARGET_DIR -and (Test-Path 'F:\')) {
    New-Item -ItemType Directory -Force -Path $fallbackBuildRoot | Out-Null
    $env:CARGO_TARGET_DIR = $fallbackBuildRoot
}
if (-not $env:TEMP -or -not (Test-Path $env:TEMP) -or ((Get-PSDrive -Name C).Free -eq 0)) {
    $fallbackTemp = 'F:\Z huabu\知瑶画布\build-tmp\verified-commits'
    New-Item -ItemType Directory -Force -Path $fallbackTemp | Out-Null
    $env:TEMP = $fallbackTemp
    $env:TMP = $fallbackTemp
}
Push-Location $repo
try {
    & (Join-Path $PSScriptRoot 'cargo-check.cmd')
    if ($LASTEXITCODE -ne 0) { throw 'Rust check failed.' }
    node (Join-Path $PSScriptRoot 'verify-frontend.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Frontend verification failed.' }
    node (Join-Path $PSScriptRoot 'audit-command-coverage.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Command coverage verification failed.' }
    git diff --check
    if ($LASTEXITCODE -ne 0) { throw 'Whitespace verification failed.' }

    # Only source, docs and scripts are eligible.  Generated artifacts, local databases,
    # user media and settings never enter the index through this helper.
    git add -- frontend src-tauri scripts docs README.md CHANGELOG.md LICENSE package.json
    $staged = @(git diff --cached --name-only)
    if ($staged.Count -eq 0) { Write-Host 'Nothing to commit.'; exit 0 }
    $secretPattern = '(?i)(sk-[a-z0-9_-]{20,}|api[_-]?key\s*[:=]\s*["''][^"'']{8,}|authorization\s*[:=]\s*["''][^"'']{8,})'
    foreach ($file in $staged) {
        if ((Test-Path -LiteralPath $file) -and -not ((Get-Item -LiteralPath $file).PSIsContainer)) {
            $match = Select-String -LiteralPath $file -Pattern $secretPattern -Quiet
            if ($match) { throw "Secret-like value detected in staged file: $file" }
        }
    }
    git commit -m $Message
    if ($LASTEXITCODE -ne 0) { throw 'Git commit failed.' }
} finally {
    Pop-Location
}
