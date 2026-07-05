use serde::{Deserialize, Serialize};

/// 文件元数据（SQLite 存储）
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct FileMeta {
    pub path: String,
    pub is_dir: bool,
    pub size: i64,
    pub etag: String,
    pub modified_at: String,
    pub created_at: String,
    pub mime_type: Option<String>,
}

/// 目录列表中的单个条目
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DirItem {
    pub name: String,
    #[serde(rename = "type")]
    pub item_type: String, // "file" | "directory"
    pub size: i64,
    pub modified_at: String,
    pub etag: String,
    pub lock: Option<LockBrief>,
}

/// 锁状态简要信息（嵌入到 DirItem 中）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockBrief {
    #[serde(rename = "type")]
    pub lock_type: String, // "read" | "write"
    pub holder: String,
    pub expires_at: String,
}

/// 目录浏览响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileListResponse {
    pub path: String,
    pub items: Vec<DirItem>,
}

/// 新建文件/目录请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateRequest {
    #[serde(rename = "type")]
    pub create_type: String, // "file" | "directory"
}

/// 重命名/移动请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameRequest {
    pub new_path: String,
}
