<#
.SYNOPSIS
setup-complete.ps1 - Windows Complete Setup (Tauri Frontend + Docker Backend)
Requires: bun, rust, docker
#>

Write-Host "🚀 Setting up Soot Shoot Retail POS (Complete Deployment) for Windows..." -ForegroundColor Cyan

# Check prerequisites
$cmds = @("bun", "cargo", "docker")
foreach ($cmd in $cmds) {
    if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
        Write-Host "❌ Error: $cmd is not installed." -ForegroundColor Red
        exit 1
    }
}

Write-Host "🐳 Starting Backend (Docker)..." -ForegroundColor Green
docker compose up -d database backend

Write-Host "📦 Installing Frontend Dependencies..." -ForegroundColor Green
Set-Location frontend
bun install

Write-Host "🔨 Building Desktop App..." -ForegroundColor Green
bun run tauri:build

Write-Host "✅ Setup Complete!" -ForegroundColor Green
Write-Host "1. Backend API: http://localhost:5001" -ForegroundColor Cyan
Write-Host "2. Desktop App: frontend\src-tauri\target\release\bundle\" -ForegroundColor Cyan
Write-Host "To run the app in dev mode: cd frontend; bun run tauri:dev"
