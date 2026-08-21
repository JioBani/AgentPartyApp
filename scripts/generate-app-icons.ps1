param([string]$Source)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$Source = if ($Source) { $Source } else { Join-Path $projectRoot "build\icon-source.png" }
$buildDir = Join-Path $projectRoot "build"
$iconDir = Join-Path $buildDir "icons"

if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
  throw "Icon source does not exist: $Source"
}

New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
$sourceImage = [System.Drawing.Image]::FromFile((Resolve-Path -LiteralPath $Source))
try {
  if ($sourceImage.Width -ne $sourceImage.Height) {
    throw "The app icon source must be square; got $($sourceImage.Width)x$($sourceImage.Height)."
  }

  $sizes = @(16, 24, 32, 48, 64, 128, 256, 512, 1024)
  foreach ($size in $sizes) {
    $bitmap = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    try {
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      try {
        $graphics.Clear([System.Drawing.Color]::Transparent)
        $graphics.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
        $graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.DrawImage($sourceImage, 0, 0, $size, $size)
      } finally {
        $graphics.Dispose()
      }
      $bitmap.Save((Join-Path $iconDir "$size.png"), [System.Drawing.Imaging.ImageFormat]::Png)
      if ($size -eq 1024) {
        $bitmap.Save((Join-Path $buildDir "icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
      }
    } finally {
      $bitmap.Dispose()
    }
  }
} finally {
  $sourceImage.Dispose()
}

$icoSizes = @(16, 24, 32, 48, 64, 128, 256)
$icoImages = $icoSizes | ForEach-Object { ,([System.IO.File]::ReadAllBytes((Join-Path $iconDir "$_.png"))) }
$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($stream)
try {
  $writer.Write([uint16]0)
  $writer.Write([uint16]1)
  $writer.Write([uint16]$icoImages.Count)
  $offset = 6 + (16 * $icoImages.Count)
  for ($index = 0; $index -lt $icoImages.Count; $index++) {
    $size = $icoSizes[$index]
    $bytes = $icoImages[$index]
    $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
    $writer.Write([byte]$(if ($size -eq 256) { 0 } else { $size }))
    $writer.Write([byte]0)
    $writer.Write([byte]0)
    $writer.Write([uint16]1)
    $writer.Write([uint16]32)
    $writer.Write([uint32]$bytes.Length)
    $writer.Write([uint32]$offset)
    $offset += $bytes.Length
  }
  foreach ($bytes in $icoImages) {
    $writer.Write($bytes)
  }
  $writer.Flush()
  [System.IO.File]::WriteAllBytes((Join-Path $buildDir "icon.ico"), $stream.ToArray())
} finally {
  $writer.Dispose()
  $stream.Dispose()
}
