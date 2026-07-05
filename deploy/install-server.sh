#!/bin/bash
# FileShare 服务端部署脚本
# 在银河麒麟 V10SP1 aarch64 上以 root 运行
# 用法: sudo ./install-server.sh [二进制文件路径]

set -euo pipefail

BINARY_SRC="${1:-fileshare-server}"
INSTALL_DIR="/usr/local/bin"
CONFIG_DIR="/etc/fileshare"
DATA_DIR="/var/lib/fileshare"
SERVICE_FILE="/etc/systemd/system/fileshare-server.service"

echo "========================================="
echo "  FileShare 服务端部署"
echo "========================================="

# 1. 创建系统用户
if ! id -u fileshare &>/dev/null; then
    useradd -r -s /sbin/nologin -d "$DATA_DIR" fileshare
    echo "已创建系统用户: fileshare"
else
    echo "系统用户 fileshare 已存在"
fi

# 2. 创建数据目录
mkdir -p "$DATA_DIR"
chown fileshare:fileshare "$DATA_DIR"
echo "数据目录已创建: $DATA_DIR"

# 3. 创建配置目录
mkdir -p "$CONFIG_DIR"

# 4. 生成默认配置（如不存在）
if [ ! -f "$CONFIG_DIR/.env" ]; then
    cat > "$CONFIG_DIR/.env" << 'EOF'
# FileShare 服务端配置
LISTEN_ADDR=0.0.0.0:8080
DATA_DIR=/var/lib/fileshare
AUTH_TOKEN=change-me-please
EOF
    echo "已生成默认配置: $CONFIG_DIR/.env"
    echo "⚠️  请修改 AUTH_TOKEN!"
else
    echo "配置文件已存在: $CONFIG_DIR/.env"
fi

# 5. 安装二进制
cp "$BINARY_SRC" "$INSTALL_DIR/fileshare-server"
chmod +x "$INSTALL_DIR/fileshare-server"
echo "二进制已安装: $INSTALL_DIR/fileshare-server"

# 6. 安装 systemd 服务
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp "$SCRIPT_DIR/fileshare-server.service" "$SERVICE_FILE"
systemctl daemon-reload
echo "systemd 服务已安装"

# 7. 启用并启动服务
systemctl enable fileshare-server
systemctl start fileshare-server
echo "服务已启动"

echo ""
echo "========================================="
echo "  部署完成!"
echo "========================================="
echo ""
echo "常用命令:"
echo "  systemctl status fileshare-server    # 查看状态"
echo "  systemctl restart fileshare-server   # 重启服务"
echo "  journalctl -u fileshare-server -f    # 查看日志"
echo ""
echo "配置文件: $CONFIG_DIR/.env"
echo "数据目录: $DATA_DIR"
echo "⚠️  请务必修改 AUTH_TOKEN!"
