#!/usr/bin/env bash
# setup-complete.sh - Linux Complete Setup (Tauri Frontend + Docker Backend)
# Requires: bun, rust, docker

echo "🚀 Setting up Soot Shoot Retail POS (Complete Deployment) for Linux..."

for cmd in bun cargo docker; do
    if ! command -v $cmd &> /dev/null; then
        echo "❌ Error: $cmd is not installed."
        exit 1
    fi
done

echo "🐳 Starting Backend (Docker)..."
docker compose up -d database backend

echo "📦 Installing Frontend Dependencies..."
cd frontend
bun install

echo "🔨 Building Desktop App..."
bun run tauri:build

echo "✅ Setup Complete!"
echo "1. Backend API: http://localhost:5001"
echo "2. Desktop App: frontend/src-tauri/target/release/bundle/"
echo "To run the app in dev mode, run: cd frontend && bun run tauri:dev"
