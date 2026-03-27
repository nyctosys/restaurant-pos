#!/usr/bin/env bash
# setup-backend.sh - Linux Backend (Docker) Setup
# Requires: docker

echo "🚀 Setting up Soot Shoot Retail POS (Backend Only) for Linux..."

if ! command -v docker &> /dev/null; then
    echo "❌ Error: Docker is not installed. Please install docker and docker-compose."
    exit 1
fi

echo "🐳 Building and starting Docker containers..."
docker compose up -d database backend

echo "✅ Setup Complete!"
echo "Backend API is running at: http://localhost:5001"
echo "Database is running on port 5432."
echo "Hardware Note: USB ESP/POS Printers ARE supported via /dev/bus/usb passthrough on Linux."
echo "To stop: docker compose stop"
