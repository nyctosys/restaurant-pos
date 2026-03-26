<#
.SYNOPSIS
windows-from-scratch.ps1 - Complete Fresh Windows 10/11 Setup Script
Automates the installation of all development binaries, compilers, and the POS software.

WARNING: This script requires Administrative privileges to run.
It will install system-wide dependencies including Docker, Rust, C++ Build Tools, and Bun.
You will likely need to restart your computer once dependencies are installed.
#>

# Ensure running as Administrator
if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "❌ This script requires Administrator privileges. Please run PowerShell as Administrator." -ForegroundColor Red
    pause
    exit 1
}

Write-Host "🚀 Starting Soot Shoot Retail POS Fresh Setup for Windows..." -ForegroundColor Cyan
Write-Host "==============================================================="

# Function to check and install via winget
function Install-Dependency ($id, $name) {
    Write-Host "`n🔍 Checking $name..." -ForegroundColor Blue
    if (winget list --id $id --exact -q) {
        Write-Host "✅ $name is already installed." -ForegroundColor Green
    } else {
        Write-Host "⏳ Installing $name..." -ForegroundColor Yellow
        winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements
        if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq 2316632065) { # 2316632065 is ok (reboot required)
            Write-Host "✅ Successfully installed $name." -ForegroundColor Green
        } else {
            Write-Host "❌ Failed to install $name. Please install it manually." -ForegroundColor Red
        }
    }
}

# 1. Install Dependencies
Write-Host "📦 Phase 1: Installing System Prerequisites" -ForegroundColor Cyan
Install-Dependency "Docker.DockerDesktop" "Docker Desktop"
Install-Dependency "Oven-sh.Bun" "Bun Package Manager"
Install-Dependency "Rustlang.Rustup" "Rust Compiler"

# Tauri also requires Microsoft Visual C++ Build Tools on Windows
Write-Host "`n🔍 Checking Visual Studio C++ Build Tools..." -ForegroundColor Blue
if (-not (Get-Command "cl.exe" -ErrorAction SilentlyContinue)) {
    Write-Host "⏳ Installing Visual Studio Build Tools (This may take a while)..." -ForegroundColor Yellow
    winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --silent --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended" --accept-package-agreements --accept-source-agreements
} else {
    Write-Host "✅ Visual Studio C++ Build Tools are already installed." -ForegroundColor Green
}

# Reload Environment Variables for the current session
Write-Host "`n♻️ Refreshing environment variables..." -ForegroundColor DarkGray
foreach($level in "Machine","User") {
    [Environment]::GetEnvironmentVariables($level).GetEnumerator() | % {
        [Environment]::SetEnvironmentVariable($_.Name, $_.Value)
    }
}

# Final Check
$missingDep = $false
foreach ($cmd in @("docker", "bun", "cargo")) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "⚠️ Warning: '$cmd' is not available in the current path." -ForegroundColor Yellow
        $missingDep = $true
    }
}

if ($missingDep) {
    Write-Host "`n⚠️  Some dependencies require a system reboot to finish setting up." -ForegroundColor Yellow
    Write-Host "Please RESTART YOUR COMPUTER and run this script again." -ForegroundColor Yellow
    pause
    exit 0
}

# 2. Start Services
Write-Host "`n🐳 Phase 2: Starting Backend APIs and Database (Docker)" -ForegroundColor Cyan
try {
    docker compose up -d database backend
    Write-Host "✅ Docker containers started." -ForegroundColor Green
} catch {
    Write-Host "❌ Failed to start Docker. Is Docker Desktop running? You may need to open Docker Desktop manually and accept the terms." -ForegroundColor Red
    pause
    exit 1
}

# 3. Build App
Write-Host "`n🔨 Phase 3: Building the POS Desktop Application" -ForegroundColor Cyan
Set-Location frontend
Write-Host "Installing frontend dependencies..." -ForegroundColor DarkGray
bun install

Write-Host "Building Tauri executable..." -ForegroundColor DarkGray
bun run tauri:build

if ($LASTEXITCODE -eq 0) {
    Write-Host "`n🎉 SUCCESS! Soot Shoot Retail POS is Ready!" -ForegroundColor Green
    Write-Host "============================================="
    Write-Host "Your production Desktop App installers (.msi) and executables (.exe) are located here:" -ForegroundColor Cyan
    Write-Host "C:\path\to\nycto-pos\frontend\src-tauri\target\release\bundle"
    Write-Host ""
    Write-Host "You can now distribute and install that .msi file on your production terminal."
} else {
    Write-Host "`n❌ Build failed. Please check the logs above." -ForegroundColor Red
}

pause
