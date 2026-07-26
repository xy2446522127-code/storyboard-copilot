param(
    [Parameter(Mandatory = $true)]
    [string]$BundleDirectory,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$')]
    [string]$Version
)

$ErrorActionPreference = 'Stop'
$directory = (Resolve-Path -LiteralPath $BundleDirectory).Path
$installer = @(Get-ChildItem -LiteralPath $directory -File -Filter '*setup.exe' |
    Where-Object { $_.Name -notmatch '^huahai-canvas-' })
if ($installer.Count -ne 1) {
    throw "Expected exactly one newly-built NSIS setup executable in $directory; found $($installer.Count)."
}
$signature = Get-Item -LiteralPath "$($installer[0].FullName).sig" -ErrorAction Stop
$artifactName = "huahai-canvas-$Version-x64-setup.exe"
$artifactPath = Join-Path $directory $artifactName
$signaturePath = "$artifactPath.sig"

# Updater URLs must be ASCII-stable. The detached updater signature covers the
# bytes rather than the filename, so copying both files does not invalidate it.
Copy-Item -LiteralPath $installer[0].FullName -Destination $artifactPath -Force
Copy-Item -LiteralPath $signature.FullName -Destination $signaturePath -Force

[PSCustomObject]@{
    installer = $artifactPath
    signature = $signaturePath
    version = $Version
} | ConvertTo-Json -Compress
