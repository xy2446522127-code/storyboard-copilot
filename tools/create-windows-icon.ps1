param(
    [Parameter(Mandatory = $true)]
    [string]$Source,
    [Parameter(Mandatory = $true)]
    [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

function Get-PngBytes {
    param([System.Drawing.Image]$Image, [int]$Size)

    $bitmap = [System.Drawing.Bitmap]::new($Size, $Size)
    try {
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([System.Drawing.Color]::Black)
            $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
            $graphics.DrawImage($Image, 0, 0, $Size, $Size)
        }
        finally {
            $graphics.Dispose()
        }

        $stream = [System.IO.MemoryStream]::new()
        try {
            $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
            return $stream.ToArray()
        }
        finally {
            $stream.Dispose()
        }
    }
    finally {
        $bitmap.Dispose()
    }
}

$sourcePath = [System.IO.Path]::GetFullPath($Source)
$destination = [System.IO.Path]::GetFullPath($OutputDirectory)
[System.IO.Directory]::CreateDirectory($destination) | Out-Null

$image = [System.Drawing.Image]::FromFile($sourcePath)
try {
    $pngPath = Join-Path $destination 'huahai-canvas.png'
    [System.IO.File]::WriteAllBytes($pngPath, (Get-PngBytes -Image $image -Size 512))

    $frames = @(16, 24, 32, 48, 64, 128, 256) | ForEach-Object {
        [PSCustomObject]@{ Size = $_; Bytes = (Get-PngBytes -Image $image -Size $_) }
    }

    $icoPath = Join-Path $destination 'huahai-canvas.ico'
    $stream = [System.IO.File]::Create($icoPath)
    $writer = [System.IO.BinaryWriter]::new($stream)
    try {
        $writer.Write([UInt16]0)
        $writer.Write([UInt16]1)
        $writer.Write([UInt16]$frames.Count)
        $offset = 6 + 16 * $frames.Count
        foreach ($frame in $frames) {
            $writer.Write([byte]$(if ($frame.Size -eq 256) { 0 } else { $frame.Size }))
            $writer.Write([byte]$(if ($frame.Size -eq 256) { 0 } else { $frame.Size }))
            $writer.Write([byte]0)
            $writer.Write([byte]0)
            $writer.Write([UInt16]1)
            $writer.Write([UInt16]32)
            $writer.Write([UInt32]$frame.Bytes.Length)
            $writer.Write([UInt32]$offset)
            $offset += $frame.Bytes.Length
        }
        foreach ($frame in $frames) {
            $writer.Write([byte[]]$frame.Bytes)
        }
    }
    finally {
        $writer.Dispose()
        $stream.Dispose()
    }
}
finally {
    $image.Dispose()
}
