param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,
    [int]$StartupSeconds = 5
)

$ErrorActionPreference = 'Stop'
$expectedTitle = ([char]0x82B1) + ([char]0x6D77) + ([char]0x753B) + ([char]0x5E03)

# A native window title can be healthy even if WebView2 failed to paint the
# application (the exact blank-window failure this release test protects).
# Print the application itself, then use deliberately low-cost colour checks:
# 花海画布's dark-blue shell contains many non-grey pixels and colour bins,
# whereas a black/white failed surface does not.  This avoids relying only on
# process liveness or a title bar.
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class HuahaiReleaseWindowProbe {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT {
    public int Left; public int Top; public int Right; public int Bottom;
  }
}
'@

function Assert-ReleaseWindowRendered {
    param([IntPtr]$WindowHandle)

    $rect = New-Object HuahaiReleaseWindowProbe+RECT
    if (-not [HuahaiReleaseWindowProbe]::GetWindowRect($WindowHandle, [ref]$rect)) {
        throw 'Unable to read the application window bounds.'
    }
    $width = $rect.Right - $rect.Left
    $height = $rect.Bottom - $rect.Top
    if ($width -lt 300 -or $height -lt 200) {
        throw "Application window has invalid bounds: ${width}x${height}."
    }

    $bitmap = New-Object System.Drawing.Bitmap $width, $height
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $deviceContext = $graphics.GetHdc()
        try {
            if (-not [HuahaiReleaseWindowProbe]::PrintWindow($WindowHandle, $deviceContext, 2)) {
                throw 'Unable to capture the WebView2 application window.'
            }
        } finally {
            $graphics.ReleaseHdc($deviceContext)
        }

        $samples = 0
        $colouredSamples = 0
        $colourBins = New-Object 'System.Collections.Generic.HashSet[int]'
        # Skip the Windows title bar and sample every 8px to keep this smoke
        # check fast even for high-resolution windows.
        for ($y = 35; $y -lt $height; $y += 8) {
            for ($x = 0; $x -lt $width; $x += 8) {
                $pixel = $bitmap.GetPixel($x, $y)
                $samples++
                $maximum = [Math]::Max($pixel.R, [Math]::Max($pixel.G, $pixel.B))
                $minimum = [Math]::Min($pixel.R, [Math]::Min($pixel.G, $pixel.B))
                if (($maximum - $minimum) -ge 12) { $colouredSamples++ }
                [void]$colourBins.Add((($pixel.R -shr 5) -shl 6) -bor (($pixel.G -shr 5) -shl 3) -bor ($pixel.B -shr 5))
            }
        }
        $colourRatio = if ($samples) { $colouredSamples / $samples } else { 0 }
        if ($colourRatio -lt 0.08 -or $colourBins.Count -lt 5) {
            throw "Application surface appears blank (colour ratio=$([Math]::Round($colourRatio, 3)), bins=$($colourBins.Count))."
        }
        return [PSCustomObject]@{ colourRatio = [Math]::Round($colourRatio, 3); colourBins = $colourBins.Count }
    } finally {
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

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
    $rendering = Assert-ReleaseWindowRendered -WindowHandle $running.MainWindowHandle
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
        rendering = $rendering
        consoleChildren = 0
        cProductPaths = 0
    } | ConvertTo-Json -Compress
} finally {
    if (-not $process.HasExited) {
        Stop-Process -Id $process.Id -Force
    }
}
