use sqlx::SqlitePool;
use std::path::Path;
use tokio::fs;
use uuid::Uuid;

/// 启动时扫描文件系统与 SQLite 元数据对齐
pub async fn sync(data_dir: &str, pool: &SqlitePool) -> Result<(), String> {
    let root = Path::new(data_dir);
    if !root.exists() {
        fs::create_dir_all(root).await.map_err(|e| e.to_string())?;
    }

    // 1. 收集磁盘上所有文件和目录
    let mut disk_paths: std::collections::HashSet<String> = std::collections::HashSet::new();
    scan_dir_recursive(root, "/", &mut disk_paths).await?;

    // 2. 收集 DB 中所有记录
    let db_rows: Vec<String> = sqlx::query_scalar("SELECT path FROM file_meta")
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;

    let db_paths: std::collections::HashSet<String> = db_rows.into_iter().collect();

    // 3. 磁盘有、DB无 → 插入
    for path in &disk_paths {
        if !db_paths.contains(path) {
            let full = root.join(path.trim_start_matches('/'));
            let meta = fs::metadata(&full).await.map_err(|e| e.to_string())?;
            let is_dir = meta.is_dir();
            let size = if is_dir { 0 } else { meta.len() as i64 };
            let etag = Uuid::new_v4().to_string();
            let now = chrono::Utc::now().to_rfc3339();

            sqlx::query(
                "INSERT INTO file_meta (path, is_dir, size, etag, modified_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(path)
            .bind(is_dir)
            .bind(size)
            .bind(&etag)
            .bind(&now)
            .bind(&now)
            .execute(pool)
            .await
            .map_err(|e| e.to_string())?;
        }
    }

    // 4. DB有、磁盘无 → 删除
    for path in &db_paths {
        if !disk_paths.contains(path) {
            sqlx::query("DELETE FROM file_meta WHERE path = ?")
                .bind(path)
                .execute(pool)
                .await
                .map_err(|e| e.to_string())?;
        }
    }

    // 5. 清理所有残留锁（服务重启，客户端连接已断开）
    sqlx::query("DELETE FROM file_locks")
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    tracing::info!(
        "元数据同步完成: 磁盘 {} 条, DB {} 条",
        disk_paths.len(),
        db_paths.len()
    );

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sqlite;

    async fn setup() -> (tempfile::TempDir, SqlitePool) {
        let tmp = tempfile::tempdir().expect("创建临时目录失败");
        let pool = sqlite::init_pool(tmp.path().to_str().unwrap())
            .await
            .expect("初始化 SQLite 失败");
        (tmp, pool)
    }

    fn data_dir(tmp: &tempfile::TempDir) -> &str {
        tmp.path().to_str().unwrap()
    }

    #[tokio::test]
    async fn test_sync_empty_dir() {
        let (tmp, pool) = setup().await;
        sync(data_dir(&tmp), &pool).await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_meta")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn test_sync_creates_nonexistent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let nonexistent = tmp.path().join("data");
        let data_dir = nonexistent.to_str().unwrap();

        let pool = sqlite::init_pool(data_dir).await.unwrap();
        sync(data_dir, &pool).await.unwrap();
        assert!(nonexistent.exists());
        pool.close().await;
    }

    #[tokio::test]
    async fn test_sync_adds_disk_files_to_db() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        // 在磁盘上创建文件（绕过 file_ops）
        tokio::fs::write(tmp.path().join("test.txt"), "hello").await.unwrap();
        tokio::fs::create_dir(tmp.path().join("subdir")).await.unwrap();
        tokio::fs::write(tmp.path().join("subdir/nested.txt"), "nested").await.unwrap();

        sync(dir, &pool).await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_meta")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 3); // test.txt, subdir, subdir/nested.txt
    }

    #[tokio::test]
    async fn test_sync_removes_db_entries_missing_from_disk() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        // 插入 DB 记录但磁盘无对应文件
        sqlx::query(
            "INSERT INTO file_meta (path, is_dir, size, etag, modified_at, created_at) VALUES (?, 0, 0, 'v1', '2026-01-01', '2026-01-01')",
        )
        .bind("/phantom.txt")
        .execute(&pool)
        .await
        .unwrap();

        sync(dir, &pool).await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_meta WHERE path = '/phantom.txt'")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn test_sync_clears_stale_locks() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        // 插入一个残留锁
        sqlx::query(
            "INSERT INTO file_locks (file_path, lock_type, holders, lease_until) VALUES (?, 'write', '[{\"client_id\":\"t\",\"user\":\"u\",\"acquired_at\":0}]', 9999999999999)",
        )
        .bind("/stale.txt")
        .execute(&pool)
        .await
        .unwrap();

        sync(dir, &pool).await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_locks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);
    }

    #[tokio::test]
    async fn test_sync_idempotent() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        tokio::fs::write(tmp.path().join("file.txt"), "data").await.unwrap();

        sync(dir, &pool).await.unwrap();
        sync(dir, &pool).await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_meta")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 1);
    }

    #[tokio::test]
    async fn test_sync_deeply_nested() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        tokio::fs::create_dir_all(tmp.path().join("a/b/c/d")).await.unwrap();
        tokio::fs::write(tmp.path().join("a/b/c/d/deep.txt"), "deep").await.unwrap();

        sync(dir, &pool).await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_meta")
            .fetch_one(&pool)
            .await
            .unwrap();
        // a, a/b, a/b/c, a/b/c/d, a/b/c/d/deep.txt = 5
        assert_eq!(count, 5);
    }
}

/// 递归扫描目录，收集相对路径
async fn scan_dir_recursive(
    root: &Path,
    current: &str,
    paths: &mut std::collections::HashSet<String>,
) -> Result<(), String> {
    let full = root.join(current.trim_start_matches('/'));
    if !full.is_dir() {
        return Ok(());
    }

    let mut entries = fs::read_dir(&full).await.map_err(|e| e.to_string())?;
    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();

        // 跳过 SQLite 内部文件，它们不属于用户数据
        if name.starts_with("metadata.db") {
            continue;
        }

        let child_rel = format!("{}/{}", current.trim_end_matches('/'), name);
        let child_full = root.join(child_rel.trim_start_matches('/'));

        paths.insert(child_rel.clone());

        if child_full.is_dir() {
            Box::pin(scan_dir_recursive(root, &child_rel, paths)).await?;
        }
    }
    Ok(())
}
