#!/usr/bin/env zsh
# setup-backend.zsh - macOS Backend (Docker) Setup
# Requires: docker

echo "🚀 Setting up Soot Shoot Retail POS (Backend Only) for macOS..."

if ! command -v docker &> /dev/null; then
    echo "❌ Error: Docker is not installed. Please install Docker Desktop for Mac."
    exit 1
fi

echo "🐳 Building and starting Docker containers..."
docker compose up -d database backend

echo "✅ Setup Complete!"
echo "Backend API is running at: http://localhost:5001"
echo "Database is running on port 5432."
echo "Note: USB Thermal printers connected to this Mac cannot be passed to Docker Desktop."
echo "To stop: docker compose stop"
