FROM rust:slim-bookworm

RUN apt-get update && apt-get install -y \
    pkg-config \
    libssl-dev \
    libsqlite3-dev \
    curl \
    libwebkit2gtk-4.0-dev \
    libgtk-3-dev \
    libayatana-appindicator3-dev \
    librsvg2-dev \
    && rm -rf /var/lib/apt/lists/*

# 安装 Node.js 20
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# ---- 服务端 ----
# 先复制 Cargo.toml 以缓存依赖
COPY server/Cargo.toml server/Cargo.lock* ./server/

# 创建空 src 以预编译依赖
RUN mkdir -p server/src server/tests && echo "" > server/src/lib.rs && echo "fn main(){}" > server/src/main.rs
WORKDIR /app/server
RUN cargo build 2>/dev/null || true

# 复制完整源码
COPY server/ .
# 强制重编译（覆盖预编译时的空 lib.rs）
RUN find src -name "*.rs" -exec touch {} + && cargo build

# ---- 客户端 Rust 侧 ----
WORKDIR /app

# 复制客户端 Cargo.toml
COPY client/src-tauri/Cargo.toml client/src-tauri/Cargo.lock* ./client/src-tauri/

# 创建空 src 以预编译依赖
RUN mkdir -p client/src-tauri/src && echo "" > client/src-tauri/src/lib.rs && echo "fn main(){}" > client/src-tauri/src/main.rs
WORKDIR /app/client/src-tauri
RUN cargo build 2>/dev/null || true

# 复制完整源码
COPY client/src-tauri/ .
# 生成 Tauri 所需的图标文件（cargo test 需要）
RUN mkdir -p icons && echo "" > icons/32x32.png && echo "" > icons/128x128.png && echo "" > icons/128x128@2x.png && echo "" > icons/icon.icns && echo "" > icons/icon.ico
# 强制重编译
RUN find src -name "*.rs" -exec touch {} + && cargo build 2>/dev/null || true

# ---- 客户端前端 ----
WORKDIR /app/client
COPY client/package.json client/package-lock.json* ./
RUN npm install 2>/dev/null || true
COPY client/ .
RUN npm install

# ---- 运行所有测试 ----
WORKDIR /app

COPY docker-entrypoint.sh .
RUN chmod +x docker-entrypoint.sh

CMD ["./docker-entrypoint.sh"]
