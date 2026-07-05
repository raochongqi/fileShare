#!/bin/bash
# 服务端原生编译脚本
# 在 aarch64 目标机上运行（银河麒麟 V10SP1）
# 产物: target/release/fileshare-server

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$PROJECT_ROOT/server"

echo "========================================="
echo "  FileShare Server 原生编译"
echo "  目标: $(uname -m) glibc $(ldd --version 2>&1 | head -1 | awk '{print $NF}')"
echo "========================================="

# 检查 Rust
if ! command -v cargo &>/dev/null; then
    echo "错误: Rust 未安装"
    echo "安装: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    exit 1
fi

# 检查 SQLite 开发库
if ! pkg-config --exists sqlite3 2>/dev/null; then
    echo "错误: libsqlite3-dev 未安装"
    echo "安装: sudo apt-get install -y libsqlite3-dev pkg-config"
    exit 1
fi

cd "$SERVER_DIR"

echo ""
echo "开始编译 (release 模式)..."
cargo build --release

BINARY="$SERVER_DIR/target/release/fileshare-server"

if [ -f "$BINARY" ]; then
    FILE_SIZE=$(du -h "$BINARY" | cut -f1)
    echo ""
    echo "========================================="
    echo "  编译成功!"
    echo "  产物: $BINARY"
    echo "  大小: $FILE_SIZE"
    echo "========================================="
    echo ""
    echo "安装到系统:"
    echo "  sudo cp $BINARY /usr/local/bin/fileshare-server"
    echo "  sudo $PROJECT_ROOT/deploy/install-server.sh /usr/local/bin/fileshare-server"
else
    echo "编译失败: 未找到产物"
    exit 1
fi
