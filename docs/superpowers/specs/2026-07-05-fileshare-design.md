# FileShare - 局域网 HTTP 文件共享系统设计

## 背景

在内网银河麒麟 V10SP1 aarch64 (glibc 2.31, kernel 5.4.18, 基于 Debian11/Ubuntu20.04) 环境中，因客户端加装安全软件后 SMB/NFS/SSHFS/WebDAV 挂载均无法正常工作（挂载文件无法通过安全系统验证导致乱码），需要自建纯 HTTP 文件共享方案。

数据存放在独立虚拟机的虚拟卷中（无安全系统限制），客户端均有安全系统限制。

## 是否需要自研

**需要。** 现有轻量方案（FileBrowser/Dufs/Gossa）均无文件锁，有锁方案（Seafile/Nextcloud）在麒麟 aarch64 上依赖链复杂、部署困难。自研是唯一能同时满足"aarch64 零依赖部署 + 并发读独占写锁 + 轻量"的路径。

## 技术栈选型

| 维度(权重) | Rust | Python | Node.js |
|-----------|------|--------|---------|
| 交叉编译(20%) | 9 | 3 | 6 |
| 运行时依赖(20%) | 10(musl) | 4 | 5 |
| 文件I/O性能(15%) | 9 | 5 | 7 |
| 并发模型(10%) | 10 | 5 | 8 |
| 文件服务生态(10%) | 7 | 5 | 9 |
| Web GUI集成(10%) | 6 | 7 | 9 |
| 静态二进制(15%) | 10 | 3 | 4 |
| **加权总分** | **8.85** | 4.45 | 6.70 |

**选定：Rust (axum + tokio + musl)**

- 服务端：axum + tokio + SQLite，编译目标 `aarch64-unknown-linux-musl`，产出零依赖静态二进制
- 客户端：Tauri 1.x（兼容已有 libwebkit2gtk-4.0）+ React 前端
- 两端均通过 `.env` 文件配置

## 整体架构

```
┌─────────────────────────────────────────────────────┐
│              Tauri 桌面客户端 (aarch64)              │
│  ┌────────────────────────────────────────────────┐ │
│  │            React 前端 UI                        │ │
│  │  文件浏览器 │ 上传下载 │ 锁状态 │ 在线文本编辑  │ │
│  └──────────────────┬─────────────────────────────┘ │
│                     │ Tauri IPC                     │
│  ┌──────────────────▼─────────────────────────────┐ │
│  │          Rust 客户端核心                        │ │
│  │  ┌──────────┐ ┌────────────┐ ┌──────────────┐ │ │
│  │  │HTTP客户端 │ │本地文件管理 │ │锁管理器      │ │ │
│  │  │(reqwest) │ │(下载/上传/ │ │(租约续期/    │ │ │
│  │  │          │ │ inotify监控)│ │ 释放/申请)   │ │ │
│  │  └─────┬────┘ └─────┬──────┘ └──────┬───────┘ │ │
│  │        └─────────────┼───────────────┘         │ │
│  │                      │                         │ │
│  │              ┌───────▼───────┐                  │ │
│  │              │ SSE 事件监听  │                  │ │
│  │              │ (文件变更通知) │                  │ │
│  │              └───────────────┘                  │ │
│  └────────────────────────────────────────────────┘ │
│  配置: .env 文件 (服务端地址、端口、Token)          │
└─────────────────────┬───────────────────────────────┘
                      │ HTTP API (局域网)
┌─────────────────────▼───────────────────────────────┐
│              Rust 服务端 (aarch64 musl)              │
│  ┌──────────┐ ┌──────────┐ ┌──────────────────────┐ │
│  │axum HTTP │ │锁管理器  │ │文件操作引擎          │ │
│  │路由层    │ │(租约+RW锁)│ │(CRUD+流式传输)       │ │
│  └─────┬────┘ └────┬─────┘ └──────────┬───────────┘ │
│        └────────────┼─────────────────┘             │
│              ┌──────▼──────┐                        │
│              │   SQLite    │                        │
│              │ (元数据+锁) │                        │
│              └─────────────┘                        │
│              ┌─────────────┐                        │
│              │  本地文件系统 │  ← 虚拟卷数据        │
│              └─────────────┘                        │
│  配置: .env 文件 (监听地址、数据路径、Token)        │
└─────────────────────────────────────────────────────┘
```

**关键决策**：
- 服务端无前端，纯 API 服务器，所有 UI 在 Tauri 客户端内
- SQLite 存元数据和锁状态，实际文件直接在磁盘
- SSE 推送文件变更和锁状态变化
- 两端都是单二进制部署

## 文件锁机制

### 锁模型：租约式读写锁

```
锁状态机：

  UNLOCKED ──── acquire_read ────► READ_LOCKED (共享)
     ▲                               │     │
     │                          +read    release_read (计数-1)
     │                          (计数+1)    │
     │                               │     ▼
     │                               │  count==0 → UNLOCKED
     │                               │
     │                          acquire_write (需 count==0)
     │                               │
     │                               ▼
     │                         WRITE_LOCKED (独占)
     │                               │
     │        release_write / lease_expire
     │                               │
     └───────────────────────────────┘
```

### 锁数据结构 (SQLite)

```sql
CREATE TABLE file_locks (
    file_path    TEXT PRIMARY KEY,       -- 文件相对路径
    lock_type    TEXT NOT NULL,          -- 'read' | 'write'
    holders      TEXT NOT NULL,          -- JSON: [{"client_id","user","acquired_at"}]
    lease_until  INTEGER NOT NULL,      -- 租约过期时间戳(ms)
    version      INTEGER NOT NULL DEFAULT 1  -- 乐观锁版本号
);
```

### 锁 API

| 操作 | 方法 | 路径 | 说明 |
|------|------|------|------|
| 申请锁 | POST | `/api/files/lock` | body: `{type:"read"/"write", path:"..."}` |
| 续租 | PUT | `/api/files/lock/lease` | Header: `X-Lock-Token` |
| 释放锁 | DELETE | `/api/files/lock` | Header: `X-Lock-Token` |
| 查询锁状态 | GET | `/api/files/lock?path=...` | 返回当前锁持有者和过期时间 |

### 租约参数

| 参数 | 值 | 理由 |
|------|---|------|
| 写锁 TTL | 60s | Office 文件编辑需要较长时间保存 |
| 读锁 TTL | 30s | 浏览/下载操作较短 |
| 续租间隔 | TTL 的 1/2 | 留足重试时间 |
| 最大续租次数 | 无限制 | 长时间编辑不应被强制中断 |
| 写锁等待超时 | 30s | 客户端等待写锁的最大时间 |

### 租约超时检查：后台清理 + 访问时检查

服务端启动 tokio 后台任务，每 10 秒扫描过期锁并清理，同时通过 SSE 广播锁释放事件。每次锁操作前额外做惰性检查，防止清理间隔内的遗漏。

### 版本冲突检测

所有写请求（上传/重命名/删除）必须携带 `If-Match: <etag>`，服务端比对版本：
- 匹配 → 执行操作，版本+1，返回新 etag
- 不匹配 → 返回 `409 Conflict`，附带服务端当前版本信息

### 客户端锁续期流程

```
1. 申请写锁 → 获得 lock_token + lease_until
2. 启动后台续租定时器（每 30s 续租一次）
3. 用户保存时：PUT 文件内容 + If-Match + lock_token
4. 用户关闭文件：释放写锁

续租失败处理：
  - 单次失败：指数退避重试（1s, 2s, 4s）
  - 连续 3 次失败：提示用户锁可能丢失，建议立即保存
  - 租约过期：强制切换为只读模式，提示文件已被其他用户修改
```

## 文件关闭检测：inotify 为主 + 手动按钮兜底

用户点击"编辑文件"后，文件下载到客户端临时目录，用 xdg-open 打开，同时启动 inotify 监听：

```
用户点击"编辑文件"
  → 申请写锁 → 下载到临时目录 → xdg-open 打开
  → inotify 监听: IN_CLOSE_WRITE + IN_OPEN + IN_MOVED_TO
  → 状态栏: "正在编辑: report.docx"

检测到 IN_CLOSE_WRITE:
  → 启动 3 秒定时器（防编辑器内部短暂关闭重开）
  → 3 秒内收到 IN_OPEN → 取消定时器，继续监听
  → 3 秒无 IN_OPEN → 判定编辑结束
    → 比较文件是否修改
    → 已修改 → 自动上传 + 释放锁
    → 未修改 → 直接释放锁

异常兜底:
  - inotify 监听失败 → 降级为手动 [完成编辑] 按钮
  - 租约 TTL → 无论什么情况，60s 无续租自动释放
```

3 秒定时器的必要性：部分编辑器（含某些版本的 LibreOffice）在"另存为"或内部自动保存时会短暂关闭再重开文件 fd。

主流编辑器 inotify 行为：
- LibreOffice/WPS：文档关闭时触发 IN_CLOSE_WRITE ✅
- gedit/kate：标签页关闭时触发 ✅
- Vim：读取后立即关闭 fd（用 swap 文件），需手动按钮 ⚠️

## CRUD 操作与 API

### API 总览

| 分类 | 方法 | 路径 | 说明 |
|------|------|------|------|
| 目录浏览 | GET | `/api/files?path=/docs` | 列出目录内容，含文件元数据和锁状态 |
| 文件下载 | GET | `/api/files/content?path=/docs/a.docx` | 流式下载，支持 Range |
| 文件上传 | PUT | `/api/files/content?path=/docs/a.docx` | 流式上传，需 If-Match |
| 新建文件 | POST | `/api/files?path=/docs/new.txt` | 创建空文件 |
| 新建目录 | POST | `/api/files?path=/docs/newdir` | 创建目录 |
| 删除 | DELETE | `/api/files?path=/docs/a.docx` | 需 If-Match |
| 重命名/移动 | PATCH | `/api/files?path=/docs/a.docx` | body:`{new_path:"..."}`, 需 If-Match |
| 文件信息 | GET | `/api/files/info?path=/docs/a.docx` | 详细元数据(大小/修改时间/etag/锁状态) |
| 搜索 | GET | `/api/files/search?q=keyword` | 按文件名搜索 |
| 锁操作 | POST/PUT/DELETE | `/api/files/lock` | 详见锁 API |
| SSE 事件 | GET | `/api/events` | 实时文件变更推送 |

### 目录浏览响应格式

```json
{
  "path": "/docs",
  "items": [
    {
      "name": "report.docx",
      "type": "file",
      "size": 245760,
      "modified_at": "2026-07-04T10:30:00Z",
      "etag": "v5",
      "lock": null
    },
    {
      "name": "subdir",
      "type": "directory",
      "size": 0,
      "modified_at": "2026-07-03T08:00:00Z",
      "lock": {
        "type": "write",
        "holder": "张三",
        "expires_at": "2026-07-04T10:31:00Z"
      }
    }
  ]
}
```

### 文件上传流程

```
客户端                            服务端
  │  1. 申请写锁                     │
  │ ──────────────────────────────► │
  │  ◄─── {lock_token, lease_until} │
  │                                 │
  │  2. 下载当前版本                  │
  │ ──────────────────────────────► │
  │  ◄─── 文件流 + ETag: "v3"       │
  │                                 │
  │  3. 用户编辑（后台续租+inotify） │
  │  ...                            │
  │                                 │
  │  4. 上传修改                     │
  │  PUT If-Match: "v3"             │
  │  X-Lock-Token: <token>          │
  │ ──────────────────────────────► │
  │  ◄─── {etag: "v4"} / 409       │
  │                                 │
  │  5. 释放写锁                     │
  │ ──────────────────────────────► │
  │  ◄─── 204 No Content            │
```

### SQLite 元数据表

```sql
CREATE TABLE file_meta (
    path         TEXT PRIMARY KEY,     -- 相对路径
    is_dir       INTEGER NOT NULL,    -- 0=文件, 1=目录
    size         INTEGER NOT NULL DEFAULT 0,
    etag         TEXT NOT NULL,        -- 版本标识
    modified_at  TEXT NOT NULL,        -- ISO8601
    created_at   TEXT NOT NULL,
    mime_type    TEXT                   -- 可选
);

CREATE TABLE op_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    path         TEXT NOT NULL,
    action       TEXT NOT NULL,        -- 'create','update','delete','rename','lock','unlock'
    user         TEXT NOT NULL,
    timestamp    INTEGER NOT NULL,     -- ms 精度
    detail       TEXT                  -- JSON
);
```

### 启动时元数据同步

服务端启动时扫描文件系统与 SQLite 对齐：
- 磁盘有、DB无 → 插入新记录
- 磁盘无、DB有 → 删除记录
- 都有但修改时间不同 → 更新 etag 和 modified_at
- 清理所有残留锁

### 流式传输

- **下载**：axum 流式返回，支持 Range 头断点续传（206 Partial Content）
- **上传**：multipart 流式接收，写入 `.tmp.{uuid}` 临时文件后原子 rename，避免半写状态

## 认证方案

共享密钥 token，通过 `.env` 配置：

```
服务端 .env: AUTH_TOKEN=my-secret-token-2026
客户端 .env: SERVER_URL=http://192.168.1.100:8080, AUTH_TOKEN=my-secret-token-2026

所有 API 请求携带 Header: Authorization: Bearer <token>
服务端 axum 中间件校验，无效返回 401
```

5-20 人内网办公场景，共享密钥足够。后续可扩展为用户名+token。

## 项目结构

```
fileShare/
├── server/                    # 服务端 (Rust, axum)
│   ├── Cargo.toml
│   ├── src/
│   │   ├── main.rs            # 入口
│   │   ├── config.rs          # 环境变量配置
│   │   ├── router.rs          # 路由定义
│   │   ├── handler/
│   │   │   ├── mod.rs
│   │   │   ├── files.rs       # 文件CRUD handler
│   │   │   ├── lock.rs        # 锁操作 handler
│   │   │   └── events.rs      # SSE handler
│   │   ├── service/
│   │   │   ├── mod.rs
│   │   │   ├── file_ops.rs    # 文件系统操作
│   │   │   ├── lock_mgr.rs    # 锁管理器
│   │   │   └── meta_sync.rs   # 启动时元数据同步
│   │   ├── model/
│   │   │   ├── mod.rs
│   │   │   ├── file.rs        # 数据结构
│   │   │   └── lock.rs        # 锁相关结构体
│   │   └── db/
│   │       ├── mod.rs
│   │       └── sqlite.rs      # SQLite 操作
│   └── .env.example
│
├── client/                    # 客户端 (Tauri + React)
│   ├── Cargo.toml
│   ├── package.json
│   ├── src-tauri/
│   │   ├── src/
│   │   │   ├── main.rs        # Tauri 入口
│   │   │   ├── http_client.rs # 服务端 API 客户端
│   │   │   ├── lock_worker.rs # 后台续租定时器
│   │   │   └── file_ops.rs    # 本地文件操作+inotify
│   │   └── tauri.conf.json
│   ├── src/                   # React 前端
│   │   ├── App.tsx
│   │   ├── components/
│   │   │   ├── FileList.tsx
│   │   │   ├── FileToolbar.tsx
│   │   │   ├── LockStatus.tsx
│   │   │   ├── TextEditor.tsx
│   │   │   └── ConfirmDialog.tsx
│   │   ├── hooks/
│   │   │   ├── useFiles.ts
│   │   │   ├── useLock.ts
│   │   │   └── useSSE.ts
│   │   ├── lib/
│   │   │   └── api.ts
│   │   └── main.tsx
│   └── .env.example
│
└── shared/                    # 共享类型（可选，ts-rs生成）
    └── types.ts
```

## 核心依赖

### 服务端

```toml
axum = "0.7"
tokio = { version = "1", features = ["full"] }
tower-http = { version = "0.5", features = ["cors", "trace"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
sqlx = { version = "0.7", features = ["sqlite", "runtime-tokio"] }
uuid = { version = "1", features = ["v4"] }
dotenvy = "0.15"
tracing = "0.1"
tracing-subscriber = "0.3"
multer = "3"
tokio-util = "0.7"
```

### 客户端 (Rust 侧)

```toml
tauri = "1"
reqwest = { version = "0.12", features = ["stream"] }
tokio = { version = "1", features = ["full"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
dotenvy = "0.15"
notify = "6"               # inotify 封装
```

### 客户端 (前端)

```json
{
  "dependencies": {
    "react": "^18",
    "react-dom": "^18",
    "@tauri-apps/api": "^1"
  },
  "devDependencies": {
    "typescript": "^5",
    "vite": "^5",
    "@vitejs/plugin-react": "^4"
  }
}
```

## MVP 功能范围

| 功能 | MVP | 后续 |
|------|:---:|:----:|
| 目录浏览 | ✅ | |
| 文件上传/下载 | ✅ | |
| 新建文件/目录 | ✅ | |
| 删除/重命名 | ✅ | |
| 写锁（独占） | ✅ | |
| 读锁（共享） | ✅ | |
| 租约续期 | ✅ | |
| 锁过期自动释放 | ✅ | |
| SSE 实时通知 | ✅ | |
| ETag 版本冲突检测 | ✅ | |
| 文本文件在线编辑 | ✅ | |
| Office 文件下载-编辑-上传 | ✅ | |
| inotify 文件关闭检测 | ✅ | |
| 共享密钥认证 | ✅ | |
| 断线重同步 | | ✅ |
| 文件搜索 | | ✅ |
| 操作日志/审计 | | ✅ |
| 回收站 | | ✅ |
| 文件预览（PDF/图片） | | ✅ |
| 多文件批量操作 | | ✅ |

## 目标环境与部署

| 项目 | 值 |
|------|---|
| 服务端 OS | 银河麒麟 V10SP1 aarch64 |
| 服务端 glibc | 2.31 (Debian11/Ubuntu20.04 兼容) |
| 服务端内核 | 5.4.18 |
| 服务端编译目标 | aarch64-unknown-linux-musl (静态链接) |
| 服务端部署 | 单二进制文件，零依赖 |
| 客户端 OS | 同上 + 安全软件 |
| 客户端 webkit2gtk | 4.0 (Tauri 1.x 兼容) |
| 客户端部署 | Tauri 打包的桌面应用 |
| 用户规模 | 5-20 人并发 |
| 文件规模 | 1-10万文件，50-500GB |
| 主要文件类型 | Office 文档、PDF、压缩包、文本文件 |
