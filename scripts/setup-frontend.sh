#!/usr/bin/env bash
# setup-frontend.sh - Linux Frontend (Tauri) Setup
# Requires: bun, rust, build-essential, libwebkit2gtk-4.0-dev, etc.

echo "🚀 Setting up Soot Shoot Retail POS (Frontend Only) for Linux..."

if ! command -v bun &> /dev/null; then
    echo "❌ Error: bun is not installed. Please install it with 'curl -fsSL https://bun.sh/install | bash'"
    exit 1
fi

if ! command -v cargo &> /dev/null; then
    echo "❌ Error: rust is not installed. Please install it with 'curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh'"
    exit 1
fi

echo "📦 Installing frontend dependencies..."
cd frontend
bun install

echo "🔨 Building Tauri App..."
bun run tauri:build

echo "✅ Setup Complete!"
echo "Run dev mode: cd frontend && bun run tauri:dev"
# Note: Linux builds usually output to frontend/src-tauri/target/release/bundle/appimage/ or deb/
echo "Desktop bundles (.AppImage, .deb) located in frontend/src-tauri/target/release/bundle/"
