#!/usr/bin/env zsh
# setup-frontend.zsh - macOS Frontend (Tauri) Setup
# Requires: bun, rust

echo "🚀 Setting up Soot Shoot Retail POS (Frontend Only) for macOS..."

# Check prerequisites
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
echo "You can find your macOS application (.dmg or .app) inside frontend/src-tauri/target/release/bundle/macos/"
echo "To run in dev mode: cd frontend && bun run tauri:dev"
