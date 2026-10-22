$ErrorActionPreference = 'Stop'
$Repository = 'DrB0rk/postmote'
$ReleaseBase = if ($env:POSTMOTE_RELEASE_BASE_URL) { $env:POSTMOTE_RELEASE_BASE_URL.TrimEnd('/') } else { "https://github.com/$Repository/releases/latest/download" }
$InstallDir = if ($env:POSTMOTE_INSTALL_DIR) { $env:POSTMOTE_INSTALL_DIR } else { Join-Path $HOME '.local\bin' }
$Asset = 'postmote-windows-x64.exe'
$TempDir = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString('N'))
$StagePath = $null

function Write-Step([string]$Message) { Write-Host "  › $Message" -ForegroundColor Cyan }
function Write-Ok([string]$Message) { Write-Host "  ✓ $Message" -ForegroundColor Green }
function Stop-Install([string]$Message) { Write-Host "  ✗ $Message" -ForegroundColor Red; exit 1 }

Write-Host "`n  POSTMOTE  ────────────────────────────" -ForegroundColor Cyan
Write-Host '  Local mail bridge installer' -ForegroundColor DarkGray
Write-Step 'Platform  Windows / x64'
Write-Step 'Download  latest verified release'

try {
  New-Item -ItemType Directory -Path $TempDir -Force | Out-Null
  $BinaryPath = Join-Path $TempDir $Asset
  $ChecksumsPath = Join-Path $TempDir 'checksums.txt'
  Invoke-WebRequest -Uri "$ReleaseBase/$Asset" -OutFile $BinaryPath
  Invoke-WebRequest -Uri "$ReleaseBase/checksums.txt" -OutFile $ChecksumsPath
  if (!(Test-Path $BinaryPath) -or (Get-Item $BinaryPath).Length -eq 0) { Stop-Install 'The downloaded release file is empty.' }
  Write-Ok 'Release downloaded'

  $ChecksumLine = Get-Content $ChecksumsPath | Where-Object { $_ -match "^[0-9a-fA-F]{64}\s+$([regex]::Escape($Asset))$" } | Select-Object -First 1
  if (!$ChecksumLine) { Stop-Install "No checksum was published for $Asset." }
  $Expected = ($ChecksumLine -split '\s+')[0].ToLowerInvariant()
  $Actual = (Get-FileHash -Path $BinaryPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($Actual -ne $Expected) { Stop-Install 'Checksum verification failed. The existing installation was left untouched.' }
  Write-Ok 'SHA-256 checksum verified'

  New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
  $Target = Join-Path $InstallDir 'postmote.exe'
  $StagePath = Join-Path $InstallDir ('.postmote-' + [System.Guid]::NewGuid().ToString('N'))
  Copy-Item -Path $BinaryPath -Destination $StagePath
  Move-Item -Path $StagePath -Destination $Target -Force
  $StagePath = $null
  Write-Ok "Installed to $Target"
  $Version = & $Target --version
  if ($LASTEXITCODE -ne 0) { Stop-Install 'The downloaded app did not start.' }
  Write-Ok "Ready: $Version"
  if (($env:PATH -split ';') -notcontains $InstallDir) {
    Write-Host "`n  Add this folder to your PATH: $InstallDir" -ForegroundColor DarkGray
  }
  Write-Host "`n  Start your local dashboard with:  postmote serve`n" -ForegroundColor Green
} catch {
  Stop-Install "Install failed: $($_.Exception.Message)"
} finally {
  if ($StagePath -and (Test-Path $StagePath)) { Remove-Item -Path $StagePath -Force }
  if (Test-Path $TempDir) { Remove-Item -Path $TempDir -Recurse -Force }
}
