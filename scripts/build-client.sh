#!/bin/bash
# FileShare 客户端构建脚本
# 在银河麒麟 V10SP1 aarch64 上运行
# 产出: src-tauri/target/release/bundle/deb/fileshare_0.1.0_arm64.deb

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLIENT_DIR="$PROJECT_ROOT/client"

echo "========================================="
echo "  FileShare 客户端构建 (aarch64)"
echo "========================================="

# 1. 检查依赖
echo "检查系统依赖..."

MISSING=()
for cmd in rustc cargo node npm; do
    if ! command -v $cmd &>/dev/null; then
        MISSING+=("$cmd")
    fi
done

# 检查 webkit2gtk
if ! pkg-config --exists webkit2gtk-4.0 2>/dev/null; then
    MISSING+=("libwebkit2gtk-4.0-dev")
fi

if [ ${#MISSING[@]} -gt 0 ]; then
    echo "缺少依赖: ${MISSING[*]}"
    echo ""
    echo "安装方法 (Ubuntu/Debian 系):"
    echo "  sudo apt-get install -y curl build-essential pkg-config libssl-dev \\"
    echo "    libwebkit2gtk-4.0-dev libgtk-3-dev libayatana-appindicator3-dev \\"
    echo "    librsvg2-dev libsqlite3-dev"
    echo ""
    echo "  # Rust"
    echo "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    echo ""
    echo "  # Node.js 20"
    echo "  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -"
    echo "  sudo apt-get install -y nodejs"
    exit 1
fi

echo "所有依赖已满足 ✓"

# 2. 安装前端依赖
cd "$CLIENT_DIR"
echo ""
echo "安装前端依赖..."
npm install

# 3. 构建 Tauri 应用 (含 deb 包)
echo ""
echo "构建 Tauri 应用 (release 模式)..."
npm run tauri build

# 4. 检查产物
DEB_DIR="$CLIENT_DIR/src-tauri/target/release/bundle/deb"
APPIMAGE_DIR="$CLIENT_DIR/src-tauri/target/release/bundle/appimage"

echo ""
echo "========================================="
echo "  构建完成!"
echo "========================================="

if [ -d "$DEB_DIR" ]; then
    DEB_FILE=$(ls "$DEB_DIR"/*.deb 2>/dev/null | head -1)
    if [ -n "$DEB_FILE" ]; then
        echo "  deb 包: $DEB_FILE"
        echo ""
        echo "安装方法:"
        echo "  sudo dpkg -i $DEB_FILE"
    fi
fi

if [ -d "$APPIMAGE_DIR" ]; then
    APPIMAGE_FILE=$(ls "$APPIMAGE_DIR"/*.AppImage 2>/dev/null | head -1)
    if [ -n "$APPIMAGE_FILE" ]; then
        echo "  AppImage: $APPIMAGE_FILE"
    fi
fi
