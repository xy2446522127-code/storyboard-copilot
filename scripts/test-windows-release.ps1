param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,
    [int]$StartupSeconds = 5
)

$ErrorActionPreference = 'Stop'
$expectedTitle = ([char]0x82B1) + ([char]0x6D77) + ([char]0x753B) + ([char]0x5E03)
$resolved = (Resolve-Path -LiteralPath $Executable).Path
if ($resolved -notmatch '^[Ff]:\\') {
    throw "Release smoke tests only run F-drive artifacts: $resolved"
}
if ($StartupSeconds -lt 2 -or $StartupSeconds -gt 30) {
    throw 'StartupSeconds must be between 2 and 30.'
}

$process = Start-Process -FilePath $resolved -PassThru
try {
    Start-Sleep -Seconds $StartupSeconds
    if ($process.HasExited) {
        throw "Release process exited early with code $($process.ExitCode)."
    }
    $running = Get-Process -Id $process.Id -ErrorAction Stop
    if ($running.MainWindowTitle -ne $expectedTitle) {
        throw "Unexpected main-window title: $($running.MainWindowTitle)"
    }
    $consoleChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($process.Id)" |
        Where-Object { $_.Name -match '^(cmd|conhost|powershell)\.exe$' })
    if ($consoleChildren.Count) {
        throw "Release started unexpected console child process(es): $($consoleChildren.Name -join ', ')"
    }
    $cProductPaths = @(
        'C:\Users\DXY\AppData\Local\HuahaiCanvas',
        'C:\Users\DXY\AppData\Local\com.huahai.canvas',
        'C:\Users\DXY\AppData\Roaming\HuahaiCanvas',
        'C:\Users\DXY\AppData\Roaming\com.huahai.canvas',
        'C:\Users\DXY\AppData\Roaming\com.storyboard-copilot.app'
    ) | Where-Object { Test-Path -LiteralPath $_ }
    if ($cProductPaths.Count) {
        throw "Product data was found on C: $($cProductPaths -join ', ')"
    }
    [PSCustomObject]@{
        executable = $resolved
        title = $running.MainWindowTitle
        startup = 'passed'
        consoleChildren = 0
        cProductPaths = 0
    } | ConvertTo-Json -Compress
} finally {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }
}
