<#
.SYNOPSIS
setup-backend.ps1 - Windows Backend (Docker) Setup
Requires: docker
#>

Write-Host "🚀 Setting up Soot Shoot Retail POS (Backend Only) for Windows..." -ForegroundColor Cyan

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "❌ Error: Docker is not installed. Please install Docker Desktop for Windows." -ForegroundColor Red
    exit 1
}

Write-Host "🐳 Building and starting Docker containers..." -ForegroundColor Green
docker compose up -d database backend

Write-Host "✅ Setup Complete!" -ForegroundColor Green
Write-Host "Backend API is running at: http://localhost:5001" -ForegroundColor Cyan
Write-Host "Database is running on port 5432."
Write-Host "Note: USB Thermal printers connected to Windows host cannot be passed directly to Docker without complex WSL2 USB passthrough setup (usbipd)." -ForegroundColor Yellow
Write-Host "To stop: docker compose stop"
