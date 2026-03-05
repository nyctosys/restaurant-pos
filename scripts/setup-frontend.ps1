<#
.SYNOPSIS
setup-frontend.ps1 - Windows Frontend (Tauri) Setup
Requires: bun, rust
#>

Write-Host "🚀 Setting up Soot Shoot Retail POS (Frontend Only) for Windows..." -ForegroundColor Cyan

# Check prerequisites
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Error: bun is not installed. Please install it from https://bun.sh/" -ForegroundColor Red
    exit 1
}

if (-not (Get-Command cargo -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Error: rust is not installed. Please install it from https://rustup.rs/" -ForegroundColor Red
    exit 1
}

Write-Host "📦 Installing frontend dependencies..." -ForegroundColor Green
Set-Location frontend
bun install

Write-Host "🔨 Building Tauri App..." -ForegroundColor Green
bun run tauri:build

Write-Host "✅ Setup Complete!" -ForegroundColor Green
Write-Host "Desktop bundles (.exe, .msi) located in frontend\src-tauri\target\release\bundle" -ForegroundColor Cyan
Write-Host "To run in dev mode: cd frontend ; bun run tauri:dev"
