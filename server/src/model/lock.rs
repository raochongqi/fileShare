use serde::{Deserialize, Serialize};

/// 锁申请请求
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockRequest {
    #[serde(rename = "type")]
    pub lock_type: String, // "read" | "write"
    pub path: String,
}

/// 锁信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockInfo {
    pub file_path: String,
    pub lock_type: String,
    pub holders: Vec<LockHolder>,
    pub lease_until: i64,
}

/// 锁持有者
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockHolder {
    pub client_id: String,
    pub user: String,
    pub acquired_at: i64,
}

/// 锁申请响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LockAcquireResponse {
    pub lock_token: String,
    pub lease_until: i64,
}
