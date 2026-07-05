# FileShare

局域网 HTTP 文件共享系统，专为银河麒麟 V10SP1 aarch64 环境设计。

## 背景

内网客户端加装安全软件后，SMB/NFS/SSHFS/WebDAV 挂载均无法正常工作。本项目通过自建纯 HTTP 文件服务实现局域网文件共享，支持并发读、独占写锁机制。

## 技术栈

- **服务端**：Rust (axum + tokio + SQLite)，编译目标 `aarch64-unknown-linux-gnu`，glibc 2.31 兼容
- **客户端**：Tauri 1.x + React + TypeScript
- **CI/CD**：GitHub Actions，arm64 原生构建，Ubuntu 20.04 容器保证 glibc 兼容

## 功能

### 服务端
- 目录浏览、文件上传/下载、新建/删除/重命名
- 租约式读写锁（并发读、独占写）
- 租约超时自动释放 + 后台清理（10s 间隔）
- ETag 版本冲突检测（If-Match）
- SSE 实时文件变更通知
- 共享密钥 Bearer Token 认证
- CORS 支持（Tauri custom-protocol origin）

### 客户端
- 文件管理器级交互体验
  - 双击进入目录 / 双击文件编辑
  - 单击选中、Ctrl 多选、Shift 范围选中
  - 右键上下文菜单（文件/目录/空白区/多选四种场景）
  - 拖拽上传（拖到窗口或拖到目录项）
  - 可点击面包屑导航
  - 文件类型图标（按扩展名区分 10 种类型）
  - 列头排序（名称/大小/修改时间，目录置顶）
  - 关键字搜索（防抖 300ms）
  - 上传进度指示
- inotify 文件关闭检测（自动上传释放锁）
- 锁状态实时显示 + 手动释放
- Ctrl+A 全选、Escape 取消选择

## 项目结构

```
server/          # 服务端 (Rust, axum)
├── src/
│   ├── lib.rs           # 库根，导出所有公共模块
│   ├── main.rs          # 入口：加载配置、初始化SQLite、启动服务+锁清理任务
│   ├── config.rs        # .env 环境变量配置
│   ├── router.rs        # 路由定义 + CORS + 认证中间件
│   ├── handler/         # HTTP handler
│   │   ├── auth.rs      # Bearer Token 认证中间件（跳过 OPTIONS 预检）
│   │   ├── files.rs     # 文件 CRUD + 搜索
│   │   ├── lock.rs      # 锁操作（申请/释放/续租/查询）+ SSE广播
│   │   └── events.rs    # SSE 事件流 (broadcast channel)
│   ├── service/         # 业务逻辑
│   │   ├── file_ops.rs  # 文件系统操作 (CRUD + 流式传输 + 路径遍历保护)
│   │   ├── file_watch.rs# inotify 文件关闭检测模块
│   │   ├── lock_mgr.rs  # 锁管理器 (租约式读写锁 + 过期清理)
│   │   └── meta_sync.rs # 启动时磁盘-DB元数据同步 + 残留锁清理
│   ├── model/           # 数据结构
│   │   ├── file.rs      # FileMeta, DirItem, FileListResponse, RenameRequest
│   │   └── lock.rs      # LockRequest, LockInfo, LockAcquireResponse, LockHolder
│   └── db/
│       └── sqlite.rs    # SQLite 连接池 + 建表 (file_meta/file_locks/op_log)
├── tests/
│   └── api_integration.rs  # HTTP 端点集成测试（30个防御性测试）
client/          # 客户端 (Tauri + React)
├── src/
│   ├── lib/
│   │   ├── api.ts              # 服务端 API 封装（14个函数）
│   │   ├── fileIcons.ts        # 文件类型图标映射（10类扩展名 + SVG）
│   │   ├── api.test.ts         # API 基础测试（23个）
│   │   └── api.defensive.test.ts # API 防御性测试（62个）
│   ├── hooks/
│   │   ├── useFiles.ts         # 文件列表 + CRUD + 排序 + 搜索 + 上传进度
│   │   ├── useLock.ts          # 锁管理 hook（申请/释放/续租）
│   │   ├── useSSE.ts           # SSE 事件监听 hook（5s 自动重连）
│   │   ├── useSelection.ts     # 多选状态管理（单击/Ctrl/Shift/全选）
│   │   ├── useDragUpload.ts    # 拖拽上传 hook（窗口级拖放监听）
│   │   └── hooks.test.ts       # Hooks 集成测试（33个）
│   ├── components/
│   │   ├── FileList.tsx        # 文件浏览表格（双击/选中/排序/右键）
│   │   ├── FileToolbar.tsx     # 面包屑导航 + 搜索 + 上传进度
│   │   ├── ContextMenu.tsx     # 右键上下文菜单（四种场景）
│   │   ├── DragOverlay.tsx     # 拖拽覆盖层
│   │   ├── LockStatus.tsx      # 活跃锁状态栏
│   │   ├── ConfirmDialog.tsx   # 删除确认对话框
│   │   ├── components.test.tsx         # 组件渲染测试（15个）
│   │   └── components.defensive.test.tsx # 组件交互防御性测试（35个）
│   ├── App.tsx                 # 主界面（集成所有 hooks + 组件 + 快捷键）
│   └── styles.css              # 暗色主题（图标颜色/菜单/拖拽/进度条）
├── src-tauri/
│   └── src/
│       ├── main.rs             # Tauri 应用入口（薄壳）
│       └── lib.rs              # 核心逻辑（下载/上传/续租/inotify）+ 54个单元测试
.github/
└── workflows/
    └── build.yml               # GitHub Actions CI（arm64 原生构建）
```

## API 一览

| 方法 | 路径 | 说明 | 认证 |
|------|------|------|:----:|
| GET | `/api/events` | SSE 实时事件流 | 否 |
| GET | `/api/files?path=` | 目录浏览 | 是 |
| GET | `/api/files/content?path=` | 文件下载（流式，支持 Range） | 是 |
| PUT | `/api/files/content?path=` | 文件上传（multipart） | 是 |
| POST | `/api/files?path=` | 新建文件/目录 | 是 |
| DELETE | `/api/files?path=` | 删除文件/目录 | 是 |
| PATCH | `/api/files?path=` | 重命名/移动 | 是 |
| GET | `/api/files/info?path=` | 文件详细元数据 | 是 |
| GET | `/api/files/search?q=` | 按文件名搜索 | 是 |
| POST | `/api/files/lock` | 申请锁（读/写） | 是 |
| PUT | `/api/files/lock/lease` | 续租（X-Lock-Token） | 是 |
| DELETE | `/api/files/lock?path=` | 释放锁（X-Lock-Token） | 是 |
| GET | `/api/files/lock?path=` | 查询锁状态 | 是 |

所有 `/api/*` 端点（除 SSE）需携带 `Authorization: Bearer <token>` 头。

## 锁机制

- **写锁 TTL**：60s，**读锁 TTL**：30s
- 客户端在 TTL 一半时续租，失败时指数退避重试
- 后台每 10s 扫描过期锁并清理
- 写操作需携带 `If-Match` ETag，版本不匹配返回 `409 Conflict`
- 释放锁通过 `X-Lock-Token` 头匹配持有者
- 锁变更时通过 SSE 广播 `lock_changed` 事件

## 实施进度

| 阶段 | 内容 | 状态 |
|------|------|:----:|
| 1 | 服务端骨架（CRUD 无锁） | ✅ |
| 2 | 锁机制（读写锁/租约/超时清理） | ✅ |
| 3 | SSE 事件 + Bearer Token 认证 | ✅ |
| 4 | 客户端骨架（Tauri + React） | ✅ |
| 5 | 客户端锁 + inotify + 编辑流程 | ✅ |
| 6 | 防御性集成测试 | ✅ |
| 7 | 交叉编译 + 部署 | ✅ |
| 8 | GitHub Actions CI/CD（arm64 原生构建） | ✅ |
| 9 | 文件管理器交互升级（右键/拖拽/搜索/排序/图标） | ✅ |

## CI/CD

GitHub Actions 工作流（`.github/workflows/build.yml`）：
- **Runner**: `ubuntu-24.04-arm`（GitHub 托管 arm64 runner）
- **容器**: Ubuntu 20.04（保证 glibc 2.31 兼容）
- **产物**:
  - `fileshare-server` — 服务端二进制
  - `file-share_0.1.0_arm64.deb` — 客户端安装包
- **触发**: push/PR 到 main 分支，或手动触发

## 测试

所有测试均在 Docker 容器中运行，确保与目标 Linux 环境行为一致：

```bash
docker-compose build        # 构建测试镜像
docker-compose up           # 运行全部测试
```

当前 332 个测试全部通过：
- **服务端单元测试** 80 个：config(4)、db(4)、file_ops(24)、meta_sync(7)、lock_mgr(22)、auth(7)、file_watch/inotify(3, Linux only)、handler(9)
- **服务端集成测试** 30 个：文件API防御性(15)、路径遍历攻击(3)、锁API防御性(5)、认证防御性(4)、工作流(3)
- **客户端 Rust 测试** 54 个：extract_file_name(13)、ClientConfig(4)、URL构造(3)、本地文件操作(4)、OpenFileParams(9)、OpenFileResult(3)、WatchContext(2)、HTTP错误路径(10)、续租错误路径(3)、文件操作(3)
- **客户端前端测试** 168 个：API基础(23)、API防御性(62)、组件渲染(15)、组件交互防御性(35)、Hooks集成(33)

## 快速开始

### 服务端（开发模式）

```bash
cd server
cp .env.example .env
# 编辑 .env 配置数据目录和认证密钥
cargo run
```

### 客户端（开发模式）

```bash
cd client
cp .env.example .env
# 编辑 .env 配置服务端地址
npm install
npm run tauri dev
```

## 部署 (aarch64 银河麒麟)

### 方式一：从 GitHub Release 下载

从 Actions 产物页面下载最新构建的二进制。

### 方式二：本地构建

#### 1. 安装构建依赖

```bash
# 系统库
sudo apt-get install -y curl build-essential pkg-config libssl-dev \
  libwebkit2gtk-4.0-dev libgtk-3-dev libayatana-appindicator3-dev \
  librsvg2-dev libsqlite3-dev

# Rust 工具链
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh

# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo bash -
sudo apt-get install -y nodejs
```

#### 2. 安装服务端

```bash
chmod +x fileshare-server
sudo cp fileshare-server /usr/local/bin/
sudo ./deploy/install-server.sh /usr/local/bin/fileshare-server
sudo vi /etc/fileshare/.env   # 修改 AUTH_TOKEN 和 DATA_DIR
sudo systemctl restart fileshare-server
```

#### 3. 安装客户端

```bash
sudo dpkg -i file-share_0.1.0_arm64.deb
# 如有依赖缺失：sudo apt-get install -f
```

### 常用运维命令

```bash
systemctl status fileshare-server     # 查看服务状态
systemctl restart fileshare-server    # 重启服务
journalctl -u fileshare-server -f     # 实时日志
```

## 文档

- [设计文档](docs/superpowers/specs/2026-07-05-fileshare-design.md)

## 目标环境

| 项目 | 值 |
|------|---|
| OS | 银河麒麟 V10SP1 aarch64 |
| glibc | 2.31 |
| 内核 | 5.4.18 |
| 用户规模 | 5-20 人并发 |
