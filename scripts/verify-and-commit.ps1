param(
    [Parameter(Mandatory = $true)]
    [ValidateNotNullOrEmpty()]
    [string]$Message
)

$ErrorActionPreference = 'Stop'
$repo = Resolve-Path (Join-Path $PSScriptRoot '..')
$fBuildRoot = 'F:\Huahaihuabu\build-cache\verified-commits'
if (-not $env:CARGO_TARGET_DIR -and (Test-Path 'F:\')) {
    New-Item -ItemType Directory -Force -Path $fBuildRoot | Out-Null
    $env:CARGO_TARGET_DIR = $fBuildRoot
}
if (-not $env:TEMP -or -not (Test-Path $env:TEMP) -or ((Get-PSDrive -Name C).Free -eq 0)) {
    $fTemp = 'F:\Huahaihuabu\build-tmp\verified-commits'
    New-Item -ItemType Directory -Force -Path $fTemp | Out-Null
    $env:TEMP = $fTemp
    $env:TMP = $fTemp
    $env:TMPDIR = $fTemp
}
if (Test-Path 'F:\') {
    # Cargo's registry, package cache and build output must stay on F: as well.
    $cargoHome = 'F:\Huahaihuabu\build-cache\cargo-home'
    New-Item -ItemType Directory -Force -Path $cargoHome | Out-Null
    $env:CARGO_HOME = $cargoHome
    # npm writes diagnostic logs even for simple package-script invocations.
    # Keep all verification artifacts off a full C: drive.
    $npmCache = 'F:\Huahaihuabu\build-cache\npm'
    New-Item -ItemType Directory -Force -Path $npmCache | Out-Null
    $env:NPM_CONFIG_CACHE = $npmCache
}
if (-not $env:GIT_DIR -and (Test-Path 'F:\') -and ((Get-PSDrive -Name C).Free -eq 0)) {
    # The source checkout may live on C:, but a commit also needs object and ref
    # locks. Keep complete Git metadata on F: so verified commits and pushes
    # never need to write to a full C: drive.
    $alternateGitDir = 'F:\Huahaihuabu\build-cache\git-metadata'
    if (-not (Test-Path (Join-Path $alternateGitDir 'HEAD'))) {
        Copy-Item -LiteralPath (Join-Path $repo '.git') -Destination $alternateGitDir -Recurse -Force
    }
    $env:GIT_DIR = $alternateGitDir
    $env:GIT_WORK_TREE = $repo
}
Push-Location $repo
try {
    & (Join-Path $PSScriptRoot 'cargo-check.cmd')
    if ($LASTEXITCODE -ne 0) { throw 'Rust check failed.' }
    node (Join-Path $PSScriptRoot 'verify-frontend.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Frontend verification failed.' }
    node (Join-Path $PSScriptRoot 'audit-command-coverage.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Command coverage verification failed.' }
    node (Join-Path $PSScriptRoot 'verify-release-config.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Release configuration verification failed.' }
    git diff --check
    if ($LASTEXITCODE -ne 0) { throw 'Whitespace verification failed.' }

    # Only source, docs and scripts are eligible. Generated artifacts, local databases,
    # user media and settings never enter the index through this helper.
    git add -- frontend src-tauri scripts docs README.md CHANGELOG.md LICENSE package.json announcements.json .gitignore
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
