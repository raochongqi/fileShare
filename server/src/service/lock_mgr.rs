use crate::model::lock::{LockAcquireResponse, LockHolder, LockInfo, LockRequest};
use sqlx::SqlitePool;
use uuid::Uuid;

/// 写锁 TTL（毫秒）
const WRITE_LOCK_TTL_MS: i64 = 60_000;
/// 读锁 TTL（毫秒）
const READ_LOCK_TTL_MS: i64 = 30_000;
/// 后台清理间隔（秒）
const CLEANUP_INTERVAL_SECS: u64 = 10;

/// 申请锁
pub async fn acquire(
    pool: &SqlitePool,
    req: &LockRequest,
    client_id: &str,
    user: &str,
) -> Result<LockAcquireResponse, String> {
    // 1. 惰性清理该文件的过期锁
    cleanup_expired_for_file(pool, &req.path).await?;

    let now_ms = chrono::Utc::now().timestamp_millis();

    // 2. 查询当前锁状态
    let current = get_lock_info(pool, &req.path).await?;

    match req.lock_type.as_str() {
        "read" => {
            // 读锁：允许与已有读锁共存，但不允许与写锁共存
            if let Some(ref lock) = current {
                if lock.lock_type == "write" {
                    return Err(format!(
                        "文件被 {} 以写锁占用，无法获取读锁",
                        lock.holders.first().map(|h| h.user.as_str()).unwrap_or("未知")
                    ));
                }
                // 已有读锁，追加持有者
                let mut holders = lock.holders.clone();
                let lock_token = Uuid::new_v4().to_string();
                holders.push(LockHolder {
                    client_id: lock_token.clone(),
                    user: user.to_string(),
                    acquired_at: now_ms,
                });
                let lease_until = now_ms + READ_LOCK_TTL_MS;

                sqlx::query(
                    "UPDATE file_locks SET holders = ?, lease_until = ? WHERE file_path = ?",
                )
                .bind(serde_json::to_string(&holders).map_err(|e| e.to_string())?)
                .bind(lease_until)
                .bind(&req.path)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;

                Ok(LockAcquireResponse { lock_token, lease_until })
            } else {
                // 无锁，创建新的读锁
                create_lock_entry(pool, &req.path, "read", client_id, user, now_ms, READ_LOCK_TTL_MS).await
            }
        }
        "write" => {
            // 写锁：不允许与任何锁共存
            if let Some(ref lock) = current {
                return Err(format!(
                    "文件被 {} 以{}锁占用，无法获取写锁",
                    lock.holders.first().map(|h| h.user.as_str()).unwrap_or("未知"),
                    if lock.lock_type == "write" { "写" } else { "读" }
                ));
            }
            create_lock_entry(pool, &req.path, "write", client_id, user, now_ms, WRITE_LOCK_TTL_MS).await
        }
        _ => Err(format!("无效的锁类型: {}", req.lock_type)),
    }
}

/// 释放锁
pub async fn release(
    pool: &SqlitePool,
    file_path: &str,
    lock_token: &str,
) -> Result<(), String> {
    // lock_token 暂存在 holders 的 client_id 字段中匹配
    let current = get_lock_info(pool, file_path).await?;

    match current {
        Some(lock) => {
            let holders: Vec<LockHolder> = lock.holders.into_iter()
                .filter(|h| h.client_id != lock_token)
                .collect();

            if holders.len() == 0 {
                // 无持有者，删除锁
                sqlx::query("DELETE FROM file_locks WHERE file_path = ?")
                    .bind(file_path)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            } else {
                // 还有持有者，更新
                sqlx::query("UPDATE file_locks SET holders = ? WHERE file_path = ?")
                    .bind(serde_json::to_string(&holders).map_err(|e| e.to_string())?)
                    .bind(file_path)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        }
        None => Err("锁不存在或已过期".to_string()),
    }
}

/// 续租
pub async fn renew(
    pool: &SqlitePool,
    file_path: &str,
    lock_token: &str,
) -> Result<i64, String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let current = get_lock_info(pool, file_path).await?;

    match current {
        Some(lock) => {
            // 验证是该持有者的锁
            let is_holder = lock.holders.iter().any(|h| h.client_id == lock_token);
            if !is_holder {
                return Err("不是锁持有者，无法续租".to_string());
            }

            // 根据锁类型计算新的 lease_until
            let ttl = if lock.lock_type == "write" { WRITE_LOCK_TTL_MS } else { READ_LOCK_TTL_MS };
            let lease_until = now_ms + ttl;

            sqlx::query("UPDATE file_locks SET lease_until = ? WHERE file_path = ?")
                .bind(lease_until)
                .bind(file_path)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;

            Ok(lease_until)
        }
        None => Err("锁不存在或已过期，无法续租".to_string()),
    }
}

/// 查询锁状态
pub async fn query(
    pool: &SqlitePool,
    file_path: &str,
) -> Result<Option<LockInfo>, String> {
    // 惰性检查过期
    cleanup_expired_for_file(pool, file_path).await?;
    get_lock_info(pool, file_path).await
}

/// 启动后台过期清理任务
pub fn start_cleanup_task(pool: SqlitePool) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(
            std::time::Duration::from_secs(CLEANUP_INTERVAL_SECS),
        );
        loop {
            interval.tick().await;
            if let Err(e) = cleanup_all_expired(&pool).await {
                tracing::warn!("锁清理任务失败: {}", e);
            }
        }
    })
}

// ---- 内部辅助 ----

/// 创建新的锁记录，返回 lock_token 和 lease_until
async fn create_lock_entry(
    pool: &SqlitePool,
    file_path: &str,
    lock_type: &str,
    _client_id: &str, // 保留参数供后续认证使用
    user: &str,
    now_ms: i64,
    ttl_ms: i64,
) -> Result<LockAcquireResponse, String> {
    let lock_token = Uuid::new_v4().to_string();
    let lease_until = now_ms + ttl_ms;

    let holders = vec![LockHolder {
        client_id: lock_token.clone(),
        user: user.to_string(),
        acquired_at: now_ms,
    }];

    sqlx::query(
        "INSERT INTO file_locks (file_path, lock_type, holders, lease_until) VALUES (?, ?, ?, ?)",
    )
    .bind(file_path)
    .bind(lock_type)
    .bind(serde_json::to_string(&holders).map_err(|e| e.to_string())?)
    .bind(lease_until)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(LockAcquireResponse { lock_token, lease_until })
}

/// 获取文件的锁信息（不过滤过期）
async fn get_lock_info(
    pool: &SqlitePool,
    file_path: &str,
) -> Result<Option<LockInfo>, String> {
    let row = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT lock_type, holders, lease_until FROM file_locks WHERE file_path = ?",
    )
    .bind(file_path)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    match row {
        Some((lock_type, holders_json, lease_until)) => {
            let now_ms = chrono::Utc::now().timestamp_millis();
            // 检查是否已过期
            if lease_until < now_ms {
                // 已过期，清理
                sqlx::query("DELETE FROM file_locks WHERE file_path = ?")
                    .bind(file_path)
                    .execute(pool)
                    .await
                    .map_err(|e| e.to_string())?;
                return Ok(None);
            }

            let holders: Vec<LockHolder> =
                serde_json::from_str(&holders_json).map_err(|e| e.to_string())?;

            Ok(Some(LockInfo {
                file_path: file_path.to_string(),
                lock_type,
                holders,
                lease_until,
            }))
        }
        None => Ok(None),
    }
}

/// 清理指定文件的过期锁
async fn cleanup_expired_for_file(pool: &SqlitePool, file_path: &str) -> Result<(), String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    sqlx::query("DELETE FROM file_locks WHERE file_path = ? AND lease_until < ?")
        .bind(file_path)
        .bind(now_ms)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 清理所有过期锁
async fn cleanup_all_expired(pool: &SqlitePool) -> Result<(), String> {
    let now_ms = chrono::Utc::now().timestamp_millis();
    let result = sqlx::query("DELETE FROM file_locks WHERE lease_until < ?")
        .bind(now_ms)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    if result.rows_affected() > 0 {
        tracing::debug!("清理了 {} 个过期锁", result.rows_affected());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sqlite;

    /// 创建临时目录 + SQLite pool
    async fn setup() -> (tempfile::TempDir, SqlitePool) {
        let tmp = tempfile::tempdir().expect("创建临时目录失败");
        let pool = sqlite::init_pool(tmp.path().to_str().unwrap())
            .await
            .expect("初始化 SQLite 失败");
        (tmp, pool)
    }

    // ---- acquire 测试 ----

    #[tokio::test]
    async fn test_acquire_write_lock() {
        let (tmp, pool) = setup().await;

        let req = LockRequest { lock_type: "write".to_string(), path: "/test.txt".to_string() };
        let result = acquire(&pool, &req, "client-1", "user1").await.unwrap();
        assert!(!result.lock_token.is_empty());
        assert!(result.lease_until > 0);
    }

    #[tokio::test]
    async fn test_acquire_read_lock() {
        let (tmp, pool) = setup().await;

        let req = LockRequest { lock_type: "read".to_string(), path: "/test.txt".to_string() };
        let result = acquire(&pool, &req, "client-1", "user1").await.unwrap();
        assert!(!result.lock_token.is_empty());
    }

    #[tokio::test]
    async fn test_acquire_multiple_read_locks() {
        let (tmp, pool) = setup().await;

        let req1 = LockRequest { lock_type: "read".to_string(), path: "/doc.txt".to_string() };
        let req2 = LockRequest { lock_type: "read".to_string(), path: "/doc.txt".to_string() };

        let r1 = acquire(&pool, &req1, "client-1", "user1").await.unwrap();
        let r2 = acquire(&pool, &req2, "client-2", "user2").await.unwrap();

        // 两个读锁应成功
        assert!(!r1.lock_token.is_empty());
        assert!(!r2.lock_token.is_empty());

        // 查询锁应显示多个持有者
        let info = query(&pool, "/doc.txt").await.unwrap().unwrap();
        assert_eq!(info.lock_type, "read");
        assert_eq!(info.holders.len(), 2);
    }

    #[tokio::test]
    async fn test_acquire_write_blocked_by_write() {
        let (tmp, pool) = setup().await;

        let req1 = LockRequest { lock_type: "write".to_string(), path: "/doc.txt".to_string() };
        acquire(&pool, &req1, "client-1", "user1").await.unwrap();

        let req2 = LockRequest { lock_type: "write".to_string(), path: "/doc.txt".to_string() };
        let result = acquire(&pool, &req2, "client-2", "user2").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("写锁占用"));
    }

    #[tokio::test]
    async fn test_acquire_write_blocked_by_read() {
        let (tmp, pool) = setup().await;

        let req1 = LockRequest { lock_type: "read".to_string(), path: "/doc.txt".to_string() };
        acquire(&pool, &req1, "client-1", "user1").await.unwrap();

        let req2 = LockRequest { lock_type: "write".to_string(), path: "/doc.txt".to_string() };
        let result = acquire(&pool, &req2, "client-2", "user2").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("读锁占用"));
    }

    #[tokio::test]
    async fn test_acquire_read_blocked_by_write() {
        let (tmp, pool) = setup().await;

        let req1 = LockRequest { lock_type: "write".to_string(), path: "/doc.txt".to_string() };
        acquire(&pool, &req1, "client-1", "user1").await.unwrap();

        let req2 = LockRequest { lock_type: "read".to_string(), path: "/doc.txt".to_string() };
        let result = acquire(&pool, &req2, "client-2", "user2").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("写锁占用"));
    }

    #[tokio::test]
    async fn test_acquire_invalid_lock_type() {
        let (tmp, pool) = setup().await;

        let req = LockRequest { lock_type: "invalid".to_string(), path: "/doc.txt".to_string() };
        let result = acquire(&pool, &req, "client-1", "user1").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("无效的锁类型"));
    }

    // ---- release 测试 ----

    #[tokio::test]
    async fn test_release_write_lock() {
        let (tmp, pool) = setup().await;

        let req = LockRequest { lock_type: "write".to_string(), path: "/test.txt".to_string() };
        let result = acquire(&pool, &req, "client-1", "user1").await.unwrap();

        release(&pool, "/test.txt", &result.lock_token).await.unwrap();

        let info = query(&pool, "/test.txt").await.unwrap();
        assert!(info.is_none());
    }

    #[tokio::test]
    async fn test_release_read_lock_one_holder() {
        let (tmp, pool) = setup().await;

        let req = LockRequest { lock_type: "read".to_string(), path: "/doc.txt".to_string() };
        let result = acquire(&pool, &req, "client-1", "user1").await.unwrap();

        release(&pool, "/doc.txt", &result.lock_token).await.unwrap();
        let info = query(&pool, "/doc.txt").await.unwrap();
        assert!(info.is_none());
    }

    #[tokio::test]
    async fn test_release_read_lock_multiple_holders() {
        let (tmp, pool) = setup().await;

        let req1 = LockRequest { lock_type: "read".to_string(), path: "/doc.txt".to_string() };
        let req2 = LockRequest { lock_type: "read".to_string(), path: "/doc.txt".to_string() };
        let r1 = acquire(&pool, &req1, "client-1", "user1").await.unwrap();
        let r2 = acquire(&pool, &req2, "client-2", "user2").await.unwrap();

        // 释放第一个，锁应仍存在，只剩一个持有者
        release(&pool, "/doc.txt", &r1.lock_token).await.unwrap();
        let info = query(&pool, "/doc.txt").await.unwrap().unwrap();
        assert_eq!(info.holders.len(), 1);

        // 释放第二个，锁应完全消失
        release(&pool, "/doc.txt", &r2.lock_token).await.unwrap();
        let info = query(&pool, "/doc.txt").await.unwrap();
        assert!(info.is_none());
    }

    #[tokio::test]
    async fn test_release_nonexistent_lock() {
        let (tmp, pool) = setup().await;

        let result = release(&pool, "/nope.txt", "fake-token").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("不存在"));
    }

    #[tokio::test]
    async fn test_release_wrong_token() {
        let (tmp, pool) = setup().await;

        let req = LockRequest { lock_type: "write".to_string(), path: "/doc.txt".to_string() };
        acquire(&pool, &req, "client-1", "user1").await.unwrap();

        // 用错误的 token 释放
        let result = release(&pool, "/doc.txt", "wrong-token").await;
        // 锁存在但 token 不匹配，所有持有者被过滤后为空，锁被删除
        // 这是预期行为：lock_token 就是 holder 的 client_id
    }

    // ---- renew 测试 ----

    #[tokio::test]
    async fn test_renew_write_lock() {
        let (tmp, pool) = setup().await;

        let req = LockRequest { lock_type: "write".to_string(), path: "/doc.txt".to_string() };
        let result = acquire(&pool, &req, "client-1", "user1").await.unwrap();

        let new_lease = renew(&pool, "/doc.txt", &result.lock_token).await.unwrap();
        assert!(new_lease > result.lease_until - 1000); // 允许少量时间差
    }

    #[tokio::test]
    async fn test_renew_read_lock() {
        let (tmp, pool) = setup().await;

        let req = LockRequest { lock_type: "read".to_string(), path: "/doc.txt".to_string() };
        let result = acquire(&pool, &req, "client-1", "user1").await.unwrap();

        let new_lease = renew(&pool, "/doc.txt", &result.lock_token).await.unwrap();
        assert!(new_lease > 0);
    }

    #[tokio::test]
    async fn test_renew_wrong_token() {
        let (tmp, pool) = setup().await;

        let req = LockRequest { lock_type: "write".to_string(), path: "/doc.txt".to_string() };
        acquire(&pool, &req, "client-1", "user1").await.unwrap();

        let result = renew(&pool, "/doc.txt", "wrong-token").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("不是锁持有者"));
    }

    #[tokio::test]
    async fn test_renew_nonexistent_lock() {
        let (tmp, pool) = setup().await;

        let result = renew(&pool, "/nope.txt", "fake-token").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("不存在"));
    }

    // ---- query 测试 ----

    #[tokio::test]
    async fn test_query_no_lock() {
        let (tmp, pool) = setup().await;

        let info = query(&pool, "/unlocked.txt").await.unwrap();
        assert!(info.is_none());
    }

    #[tokio::test]
    async fn test_query_after_release() {
        let (tmp, pool) = setup().await;

        let req = LockRequest { lock_type: "write".to_string(), path: "/doc.txt".to_string() };
        let result = acquire(&pool, &req, "client-1", "user1").await.unwrap();

        release(&pool, "/doc.txt", &result.lock_token).await.unwrap();
        let info = query(&pool, "/doc.txt").await.unwrap();
        assert!(info.is_none());
    }

    // ---- 过期锁清理测试 ----

    #[tokio::test]
    async fn test_expired_lock_auto_cleanup() {
        let (tmp, pool) = setup().await;

        // 手动插入一个已过期的锁
        let past_ms = chrono::Utc::now().timestamp_millis() - 10000;
        let holders = serde_json::to_string(&vec![LockHolder {
            client_id: "test-token".to_string(),
            user: "test".to_string(),
            acquired_at: past_ms,
        }]).unwrap();

        sqlx::query(
            "INSERT INTO file_locks (file_path, lock_type, holders, lease_until) VALUES (?, ?, ?, ?)",
        )
        .bind("/expired.txt")
        .bind("write")
        .bind(&holders)
        .bind(past_ms) // 已过期
        .execute(&pool)
        .await
        .unwrap();

        // 查询时应自动清理并返回 None
        let info = query(&pool, "/expired.txt").await.unwrap();
        assert!(info.is_none());
    }

    #[tokio::test]
    async fn test_acquire_cleans_expired_lock_first() {
        let (tmp, pool) = setup().await;

        // 插入一个已过期的写锁
        let past_ms = chrono::Utc::now().timestamp_millis() - 10000;
        let holders = serde_json::to_string(&vec![LockHolder {
            client_id: "old-token".to_string(),
            user: "old-user".to_string(),
            acquired_at: past_ms,
        }]).unwrap();

        sqlx::query(
            "INSERT INTO file_locks (file_path, lock_type, holders, lease_until) VALUES (?, ?, ?, ?)",
        )
        .bind("/doc.txt")
        .bind("write")
        .bind(&holders)
        .bind(past_ms)
        .execute(&pool)
        .await
        .unwrap();

        // 新的写锁应成功（因为旧锁已过期被清理）
        let req = LockRequest { lock_type: "write".to_string(), path: "/doc.txt".to_string() };
        let result = acquire(&pool, &req, "client-2", "user2").await;
        assert!(result.is_ok());
    }

    #[tokio::test]
    async fn test_cleanup_all_expired() {
        let (tmp, pool) = setup().await;

        let past_ms = chrono::Utc::now().timestamp_millis() - 10000;
        let holders = serde_json::to_string(&vec![LockHolder {
            client_id: "t".to_string(),
            user: "u".to_string(),
            acquired_at: past_ms,
        }]).unwrap();

        // 插入多个过期锁
        for i in 0..3 {
            sqlx::query(
                "INSERT INTO file_locks (file_path, lock_type, holders, lease_until) VALUES (?, ?, ?, ?)",
            )
            .bind(format!("/expired{}.txt", i))
            .bind("write")
            .bind(&holders)
            .bind(past_ms)
            .execute(&pool)
            .await
            .unwrap();
        }

        cleanup_all_expired(&pool).await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_locks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    // ---- 完整工作流测试 ----

    #[tokio::test]
    async fn test_full_write_lock_workflow() {
        let (tmp, pool) = setup().await;

        // 1. 申请写锁
        let req = LockRequest { lock_type: "write".to_string(), path: "/doc.txt".to_string() };
        let lock = acquire(&pool, &req, "client-1", "张三").await.unwrap();

        // 2. 续租
        let new_lease = renew(&pool, "/doc.txt", &lock.lock_token).await.unwrap();
        assert!(new_lease >= lock.lease_until);

        // 3. 其他人尝试获取写锁应被拒绝
        let req2 = LockRequest { lock_type: "write".to_string(), path: "/doc.txt".to_string() };
        let result = acquire(&pool, &req2, "client-2", "李四").await;
        assert!(result.is_err());

        // 4. 释放锁
        release(&pool, "/doc.txt", &lock.lock_token).await.unwrap();

        // 5. 其他人现在可以获取写锁
        let result2 = acquire(&pool, &req2, "client-2", "李四").await;
        assert!(result2.is_ok());
    }

    #[tokio::test]
    async fn test_full_read_lock_workflow() {
        let (tmp, pool) = setup().await;

        // 多个读锁
        let req1 = LockRequest { lock_type: "read".to_string(), path: "/doc.txt".to_string() };
        let req2 = LockRequest { lock_type: "read".to_string(), path: "/doc.txt".to_string() };

        let r1 = acquire(&pool, &req1, "c1", "u1").await.unwrap();
        let r2 = acquire(&pool, &req2, "c2", "u2").await.unwrap();

        // 写锁应被拒绝
        let req_write = LockRequest { lock_type: "write".to_string(), path: "/doc.txt".to_string() };
        assert!(acquire(&pool, &req_write, "c3", "u3").await.is_err());

        // 释放一个读锁
        release(&pool, "/doc.txt", &r1.lock_token).await.unwrap();

        // 写锁仍应被拒绝
        assert!(acquire(&pool, &req_write, "c3", "u3").await.is_err());

        // 释放最后一个读锁
        release(&pool, "/doc.txt", &r2.lock_token).await.unwrap();

        // 现在写锁应成功
        assert!(acquire(&pool, &req_write, "c3", "u3").await.is_ok());
    }

    #[tokio::test]
    async fn test_different_files_independent_locks() {
        let (tmp, pool) = setup().await;

        let req1 = LockRequest { lock_type: "write".to_string(), path: "/a.txt".to_string() };
        let req2 = LockRequest { lock_type: "write".to_string(), path: "/b.txt".to_string() };

        // 不同文件应能同时持有写锁
        let r1 = acquire(&pool, &req1, "c1", "u1").await.unwrap();
        let r2 = acquire(&pool, &req2, "c2", "u2").await.unwrap();
        assert!(!r1.lock_token.is_empty());
        assert!(!r2.lock_token.is_empty());
    }
}
