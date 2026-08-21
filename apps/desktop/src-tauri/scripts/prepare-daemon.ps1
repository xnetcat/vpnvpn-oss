# Build the daemon and copy it with the correct target triple name for Tauri bundling.
# PowerShell version for Windows

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$SrcTauriDir = Split-Path -Parent $ScriptDir
$DaemonDir = Join-Path $SrcTauriDir "..\daemon"
$BinariesDir = Join-Path $SrcTauriDir "binaries"

# Determine the target triple
$Arch = $env:PROCESSOR_ARCHITECTURE
switch ($Arch) {
    "AMD64" { $TargetTriple = "x86_64-pc-windows-msvc" }
    "ARM64" { $TargetTriple = "aarch64-pc-windows-msvc" }
    default { throw "Unknown architecture: $Arch" }
}

$DaemonName = "vpnvpn-daemon.exe"
$SidecarName = "vpnvpn-daemon-$TargetTriple.exe"

Write-Host "Building daemon for $TargetTriple..."

# Build the daemon in release mode
Push-Location $DaemonDir
try {
    cargo build --release
    if ($LASTEXITCODE -ne 0) {
        throw "Cargo build failed"
    }
} finally {
    Pop-Location
}

# Create binaries directory if it doesn't exist
if (-not (Test-Path $BinariesDir)) {
    New-Item -ItemType Directory -Path $BinariesDir | Out-Null
}

# Copy the daemon with the correct sidecar name
$BuiltDaemon = Join-Path $DaemonDir "target\release\$DaemonName"
$SidecarPath = Join-Path $BinariesDir $SidecarName

if (Test-Path $BuiltDaemon) {
    Write-Host "Copying $BuiltDaemon -> $SidecarPath"
    Copy-Item $BuiltDaemon $SidecarPath -Force
    Write-Host "Daemon prepared successfully: $SidecarPath"
} else {
    throw "ERROR: Daemon binary not found at $BuiltDaemon"
}

