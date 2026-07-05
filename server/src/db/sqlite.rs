use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use std::path::Path;
use std::str::FromStr;
use tokio::fs;

/// 初始化 SQLite 连接池并建表
pub async fn init_pool(data_dir: &str) -> Result<SqlitePool, sqlx::Error> {
    let db_path = Path::new(data_dir).join("metadata.db");

    // 确保 DB 文件的父目录存在（支持嵌套不存在的目录）
    if let Some(parent) = db_path.parent() {
        fs::create_dir_all(parent).await?;
    }

    let db_url = format!("sqlite:{}?mode=rwc", db_path.display());

    let options = SqliteConnectOptions::from_str(&db_url)?
        .create_if_missing(true)
        .journal_mode(sqlx::sqlite::SqliteJournalMode::Wal);

    let pool = SqlitePoolOptions::new()
        .max_connections(5)
        .connect_with(options)
        .await?;

    // 建表
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS file_meta (
            path         TEXT PRIMARY KEY,
            is_dir       INTEGER NOT NULL DEFAULT 0,
            size         INTEGER NOT NULL DEFAULT 0,
            etag         TEXT NOT NULL,
            modified_at  TEXT NOT NULL,
            created_at   TEXT NOT NULL,
            mime_type    TEXT
        )
        "#,
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS file_locks (
            file_path    TEXT PRIMARY KEY,
            lock_type    TEXT NOT NULL,
            holders      TEXT NOT NULL,
            lease_until  INTEGER NOT NULL,
            version      INTEGER NOT NULL DEFAULT 1
        )
        "#,
    )
    .execute(&pool)
    .await?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS op_log (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            path         TEXT NOT NULL,
            action       TEXT NOT NULL,
            user         TEXT NOT NULL,
            timestamp    INTEGER NOT NULL,
            detail       TEXT
        )
        "#,
    )
    .execute(&pool)
    .await?;

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 创建临时目录和 SQLite 连接池用于测试
    async fn setup() -> (tempfile::TempDir, SqlitePool) {
        let tmp = tempfile::tempdir().expect("创建临时目录失败");
        let pool = init_pool(tmp.path().to_str().unwrap())
            .await
            .expect("初始化 SQLite 失败");
        (tmp, pool)
    }

    #[tokio::test]
    async fn test_init_pool_creates_db_file() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_str().unwrap();
        let pool = init_pool(data_dir).await.unwrap();
        assert!(tmp.path().join("metadata.db").exists());
        pool.close().await;
    }

    #[tokio::test]
    async fn test_init_pool_creates_tables() {
        let (tmp, pool) = setup().await;

        // 验证 file_meta 表存在
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_meta")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);

        // 验证 file_locks 表存在
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_locks")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);

        // 验证 op_log 表存在
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM op_log")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(count, 0);

        drop(tmp);
        pool.close().await;
    }

    #[tokio::test]
    async fn test_init_pool_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_str().unwrap();

        // 多次初始化不应报错
        let pool1 = init_pool(data_dir).await.unwrap();
        pool1.close().await;
        let pool2 = init_pool(data_dir).await.unwrap();

        // 插入数据后再次初始化不应丢失
        sqlx::query("INSERT INTO file_meta (path, is_dir, size, etag, modified_at, created_at) VALUES ('/test', 0, 100, 'v1', '2026-01-01', '2026-01-01')")
            .execute(&pool2)
            .await
            .unwrap();

        pool2.close().await;
        let pool3 = init_pool(data_dir).await.unwrap();

        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM file_meta")
            .fetch_one(&pool3)
            .await
            .unwrap();
        assert_eq!(count, 1);

        drop(tmp);
        pool3.close().await;
    }

    #[tokio::test]
    async fn test_init_pool_nonexistent_dir() {
        let tmp = tempfile::tempdir().unwrap();
        let nonexistent = tmp.path().join("nested/deep/dir");
        let data_dir = nonexistent.to_str().unwrap();

        // SQLite 会自动创建嵌套目录中的 db 文件
        let pool = init_pool(data_dir).await.unwrap();
        assert!(nonexistent.join("metadata.db").exists());
        drop(tmp);
        pool.close().await;
    }
}
