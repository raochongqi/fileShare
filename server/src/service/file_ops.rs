use crate::model::file::{DirItem, FileListResponse, LockBrief};
use bytes::Bytes;
use sqlx::SqlitePool;
use std::path::{Path, PathBuf};
use tokio::fs;
use uuid::Uuid;

/// 获取数据目录的绝对路径
fn data_root(data_dir: &str) -> PathBuf {
    PathBuf::from(data_dir)
}

/// 将相对路径解析为磁盘绝对路径，并校验不越界
fn resolve_path(data_dir: &str, relative: &str) -> Result<PathBuf, String> {
    let root = data_root(data_dir).canonicalize().unwrap_or_else(|_| data_root(data_dir));
    let rel = Path::new(relative).strip_prefix("/").unwrap_or(Path::new(relative));
    let full = root.join(rel);

    // 路径遍历保护：确保结果路径在数据目录内
    let canonical = full.canonicalize().unwrap_or_else(|_| full.clone());
    if !canonical.starts_with(&root) {
        return Err("路径越界".to_string());
    }
    Ok(full)
}

/// 列出目录内容
pub async fn list_dir(
    data_dir: &str,
    pool: &SqlitePool,
    relative: &str,
) -> Result<FileListResponse, String> {
    let full_path = resolve_path(data_dir, relative)?;
    if !full_path.is_dir() {
        return Err("路径不是目录".to_string());
    }

    let mut items = Vec::new();
    let mut entries = fs::read_dir(&full_path).await.map_err(|e| e.to_string())?;

    while let Some(entry) = entries.next_entry().await.map_err(|e| e.to_string())? {
        let name = entry.file_name().to_string_lossy().to_string();

        // 跳过 SQLite 内部文件，它们不应出现在目录列表中
        if name.starts_with("metadata.db") {
            continue;
        }

        let meta = entry.metadata().await.map_err(|e| e.to_string())?;
        let is_dir = meta.is_dir();
        let size = meta.len() as i64;
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| {
                chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)
                    .unwrap_or_default()
                    .to_rfc3339()
            })
            .unwrap_or_default();

        // 构造相对路径查询锁状态
        let item_rel_path = format!("{}/{}", relative.trim_end_matches('/'), name);
        let lock = get_lock_brief(pool, &item_rel_path).await;

        // 查询 etag
        let etag = sqlx::query_scalar::<_, String>(
            "SELECT etag FROM file_meta WHERE path = ?",
        )
        .bind(&item_rel_path)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .unwrap_or_else(|| Uuid::new_v4().to_string());

        items.push(DirItem {
            name,
            item_type: if is_dir { "directory".to_string() } else { "file".to_string() },
            size,
            modified_at: modified,
            etag,
            lock,
        });
    }

    // 按目录优先、名称排序（"directory" 字母序小于 "file"，升序即目录优先）
    items.sort_by(|a, b| {
        a.item_type.cmp(&b.item_type).then(a.name.cmp(&b.name))
    });

    Ok(FileListResponse {
        path: relative.to_string(),
        items,
    })
}

/// 读取文件，返回文件路径用于流式传输
pub async fn read_file(data_dir: &str, relative: &str) -> Result<PathBuf, String> {
    let full_path = resolve_path(data_dir, relative)?;
    if !full_path.is_file() {
        return Err("文件不存在".to_string());
    }
    Ok(full_path)
}

/// 写入文件（上传）：写入临时文件后原子 rename
pub async fn write_file(
    data_dir: &str,
    pool: &SqlitePool,
    relative: &str,
    data: Bytes,
) -> Result<String, String> {
    let full_path = resolve_path(data_dir, relative)?;

    // 确保父目录存在
    if let Some(parent) = full_path.parent() {
        fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }

    // 写入临时文件
    let tmp_path = full_path.with_extension(format!("tmp.{}", Uuid::new_v4()));
    fs::write(&tmp_path, &data).await.map_err(|e| e.to_string())?;

    // 原子 rename
    fs::rename(&tmp_path, &full_path).await.map_err(|e| {
        // 清理临时文件
        let tmp = tmp_path.clone();
        tokio::spawn(async move {
            let _ = fs::remove_file(&tmp).await;
        });
        e.to_string()
    })?;

    // 更新元数据
    let etag = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();
    let size = data.len() as i64;
    let is_dir = false;
    let mime_type = guess_mime(relative);

    upsert_meta(pool, relative, is_dir, size, &etag, &now, mime_type.as_deref()).await?;

    Ok(etag)
}

/// 创建空文件或目录
pub async fn create_entry(
    data_dir: &str,
    pool: &SqlitePool,
    relative: &str,
    is_dir: bool,
) -> Result<String, String> {
    let full_path = resolve_path(data_dir, relative)?;

    if full_path.exists() {
        return Err("路径已存在".to_string());
    }

    if is_dir {
        fs::create_dir_all(&full_path).await.map_err(|e| e.to_string())?;
    } else {
        if let Some(parent) = full_path.parent() {
            fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
        }
        fs::write(&full_path, "").await.map_err(|e| e.to_string())?;
    }

    let etag = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    upsert_meta(pool, relative, is_dir, 0, &etag, &now, None).await?;

    Ok(etag)
}

/// 删除文件或目录
pub async fn delete_entry(
    data_dir: &str,
    pool: &SqlitePool,
    relative: &str,
) -> Result<(), String> {
    let full_path = resolve_path(data_dir, relative)?;

    if !full_path.exists() {
        return Err("路径不存在".to_string());
    }

    if full_path.is_dir() {
        fs::remove_dir_all(&full_path).await.map_err(|e| e.to_string())?;
    } else {
        fs::remove_file(&full_path).await.map_err(|e| e.to_string())?;
    }

    // 删除元数据
    sqlx::query("DELETE FROM file_meta WHERE path = ? OR path LIKE ?")
        .bind(relative)
        .bind(format!("{}/%", relative))
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    Ok(())
}

/// 重命名/移动
pub async fn rename_entry(
    data_dir: &str,
    pool: &SqlitePool,
    old_relative: &str,
    new_relative: &str,
) -> Result<String, String> {
    let old_path = resolve_path(data_dir, old_relative)?;
    let new_path = resolve_path(data_dir, new_relative)?;

    if !old_path.exists() {
        return Err("源路径不存在".to_string());
    }
    if new_path.exists() {
        return Err("目标路径已存在".to_string());
    }

    // 确保目标父目录存在
    if let Some(parent) = new_path.parent() {
        fs::create_dir_all(parent).await.map_err(|e| e.to_string())?;
    }

    fs::rename(&old_path, &new_path).await.map_err(|e| e.to_string())?;

    // 更新元数据：删除旧记录，插入新记录
    let etag = Uuid::new_v4().to_string();
    let now = chrono::Utc::now().to_rfc3339();

    // 获取旧元数据
    let old_meta = sqlx::query_as::<_, crate::model::file::FileMeta>(
        "SELECT * FROM file_meta WHERE path = ?",
    )
    .bind(old_relative)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    let (is_dir, size, mime_type) = match &old_meta {
        Some(m) => (m.is_dir, m.size, m.mime_type.clone()),
        None => (old_path.is_dir(), 0, None),
    };

    sqlx::query("DELETE FROM file_meta WHERE path = ?")
        .bind(old_relative)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;

    upsert_meta(pool, new_relative, is_dir, size, &etag, &now, mime_type.as_deref()).await?;

    Ok(etag)
}

/// 获取文件详细元数据
pub async fn get_file_info(
    data_dir: &str,
    pool: &SqlitePool,
    relative: &str,
) -> Result<crate::model::file::FileMeta, String> {
    let full_path = resolve_path(data_dir, relative)?;
    if !full_path.exists() {
        return Err("文件不存在".to_string());
    }

    let meta = sqlx::query_as::<_, crate::model::file::FileMeta>(
        "SELECT * FROM file_meta WHERE path = ?",
    )
    .bind(relative)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;

    match meta {
        Some(m) => Ok(m),
        None => {
            // 磁盘有但 DB 无，同步后返回
            let etag = Uuid::new_v4().to_string();
            let now = chrono::Utc::now().to_rfc3339();
            let fs_meta = fs::metadata(&full_path).await.map_err(|e| e.to_string())?;
            let is_dir = fs_meta.is_dir();
            let size = fs_meta.len() as i64;
            let mime_type = if is_dir { None } else { guess_mime(relative) };

            upsert_meta(pool, relative, is_dir, size, &etag, &now, mime_type.as_deref()).await?;

            sqlx::query_as::<_, crate::model::file::FileMeta>(
                "SELECT * FROM file_meta WHERE path = ?",
            )
            .bind(relative)
            .fetch_one(pool)
            .await
            .map_err(|e| e.to_string())
        }
    }
}

// ---- 内部辅助函数 ----

/// 插入或更新文件元数据
async fn upsert_meta(
    pool: &SqlitePool,
    path: &str,
    is_dir: bool,
    size: i64,
    etag: &str,
    now: &str,
    mime_type: Option<&str>,
) -> Result<(), String> {
    sqlx::query(
        r#"INSERT INTO file_meta (path, is_dir, size, etag, modified_at, created_at, mime_type)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             is_dir = excluded.is_dir,
             size = excluded.size,
             etag = excluded.etag,
             modified_at = excluded.modified_at,
             mime_type = excluded.mime_type"#,
    )
    .bind(path)
    .bind(is_dir)
    .bind(size)
    .bind(etag)
    .bind(now)
    .bind(now)
    .bind(mime_type)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// 获取文件的锁简要信息
async fn get_lock_brief(pool: &SqlitePool, path: &str) -> Option<LockBrief> {
    let now_ms = chrono::Utc::now().timestamp_millis();

    let lock = sqlx::query_as::<_, (String, String, i64)>(
        "SELECT lock_type, holders, lease_until FROM file_locks WHERE file_path = ? AND lease_until > ?",
    )
    .bind(path)
    .bind(now_ms)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()?;

    let holders: Vec<crate::model::lock::LockHolder> =
        serde_json::from_str(&lock.1).ok().unwrap_or_default();
    let holder_name = holders.first().map(|h| h.user.clone()).unwrap_or_default();
    let expires = chrono::DateTime::from_timestamp_millis(lock.2)
        .unwrap_or_default()
        .to_rfc3339();

    Some(LockBrief {
        lock_type: lock.0,
        holder: holder_name,
        expires_at: expires,
    })
}

/// 根据扩展名猜测 MIME 类型（供 handler 调用的公开版本，始终返回有效值）
pub fn guess_mime_static(path: &str) -> &'static str {
    let ext = Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    match ext.as_str() {
        "txt" => "text/plain",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" => "application/javascript",
        "json" => "application/json",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        "doc" | "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" | "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" | "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "zip" => "application/zip",
        "tar" => "application/x-tar",
        "gz" | "tgz" => "application/gzip",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    }
}

/// 根据扩展名猜测 MIME 类型（内部版本，返回 Option）
fn guess_mime(path: &str) -> Option<String> {
    let ext = Path::new(path).extension()?.to_str()?.to_lowercase();
    Some(match ext.as_str() {
        "txt" => "text/plain",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" => "application/javascript",
        "json" => "application/json",
        "xml" => "application/xml",
        "pdf" => "application/pdf",
        "doc" | "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" | "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" | "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "zip" => "application/zip",
        "tar" => "application/x-tar",
        "gz" | "tgz" => "application/gzip",
        "7z" => "application/x-7z-compressed",
        "rar" => "application/vnd.rar",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "mp4" => "video/mp4",
        "mp3" => "audio/mpeg",
        _ => "application/octet-stream",
    }.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::sqlite;

    /// 创建临时数据目录 + SQLite pool
    async fn setup() -> (tempfile::TempDir, SqlitePool) {
        let tmp = tempfile::tempdir().expect("创建临时目录失败");
        let pool = sqlite::init_pool(tmp.path().to_str().unwrap())
            .await
            .expect("初始化 SQLite 失败");
        (tmp, pool)
    }

    fn data_dir(tmp: &tempfile::TempDir) -> String {
        tmp.path().to_str().unwrap().to_string()
    }

    // ---- resolve_path 测试 ----

    #[test]
    fn test_resolve_path_normal() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_str().unwrap();
        // 创建目录使其可 canonicalize
        let result = resolve_path(data_dir, "/docs/test.txt");
        assert!(result.is_ok());
    }

    #[test]
    fn test_resolve_path_traversal_attack() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_str().unwrap();
        // 路径遍历攻击
        let result = resolve_path(data_dir, "/../../../etc/passwd");
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("越界"));
    }

    #[test]
    fn test_resolve_path_double_dot_in_middle() {
        let tmp = tempfile::tempdir().unwrap();
        let data_dir = tmp.path().to_str().unwrap();
        let result = resolve_path(data_dir, "/docs/../secret");
        // 根据实现，可能越界也可能被 canonicalize 后安全
        // 关键是不应访问到数据目录之外的文件
        if let Ok(path) = result {
            let root = std::path::PathBuf::from(data_dir).canonicalize().unwrap_or_else(|_| std::path::PathBuf::from(data_dir));
            let canonical = path.canonicalize().unwrap_or_else(|_| path);
            assert!(canonical.starts_with(&root), "解析后的路径不应越界");
        }
    }

    // ---- guess_mime 测试 ----

    #[test]
    fn test_guess_mime_static_known_types() {
        assert_eq!(guess_mime_static("test.txt"), "text/plain");
        assert_eq!(guess_mime_static("doc.pdf"), "application/pdf");
        assert_eq!(guess_mime_static("image.png"), "image/png");
        assert_eq!(guess_mime_static("image.jpg"), "image/jpeg");
        assert_eq!(guess_mime_static("image.jpeg"), "image/jpeg");
        assert_eq!(guess_mime_static("doc.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
        assert_eq!(guess_mime_static("sheet.xlsx"), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        assert_eq!(guess_mime_static("archive.zip"), "application/zip");
    }

    #[test]
    fn test_guess_mime_static_unknown() {
        assert_eq!(guess_mime_static("file.xyz"), "application/octet-stream");
        assert_eq!(guess_mime_static("noext"), "application/octet-stream");
    }

    #[test]
    fn test_guess_mime_static_case_insensitive() {
        assert_eq!(guess_mime_static("photo.PNG"), "image/png");
        assert_eq!(guess_mime_static("doc.PDF"), "application/pdf");
    }

    // ---- create_entry 测试 ----

    #[tokio::test]
    async fn test_create_file() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        let etag = create_entry(&dir, &pool, "/test.txt", false).await.unwrap();
        assert!(!etag.is_empty());
        assert!(tmp.path().join("test.txt").exists());
    }

    #[tokio::test]
    async fn test_create_directory() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        let etag = create_entry(&dir, &pool, "/subdir", true).await.unwrap();
        assert!(!etag.is_empty());
        assert!(tmp.path().join("subdir").is_dir());
    }

    #[tokio::test]
    async fn test_create_nested_directory() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        let etag = create_entry(&dir, &pool, "/a/b/c", true).await.unwrap();
        assert!(tmp.path().join("a/b/c").is_dir());
    }

    #[tokio::test]
    async fn test_create_entry_already_exists() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        create_entry(&dir, &pool, "/test.txt", false).await.unwrap();
        let result = create_entry(&dir, &pool, "/test.txt", false).await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("已存在"));
    }

    // ---- write_file 测试 ----

    #[tokio::test]
    async fn test_write_file_new() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        let data = Bytes::from("hello world");
        let etag = write_file(&dir, &pool, "/hello.txt", data).await.unwrap();
        assert!(!etag.is_empty());

        let content = tokio::fs::read_to_string(tmp.path().join("hello.txt")).await.unwrap();
        assert_eq!(content, "hello world");
    }

    #[tokio::test]
    async fn test_write_file_overwrite() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        write_file(&dir, &pool, "/data.txt", Bytes::from("version1")).await.unwrap();
        let etag2 = write_file(&dir, &pool, "/data.txt", Bytes::from("version2")).await.unwrap();

        let content = tokio::fs::read_to_string(tmp.path().join("data.txt")).await.unwrap();
        assert_eq!(content, "version2");
        assert!(!etag2.is_empty());
    }

    #[tokio::test]
    async fn test_write_file_nested_path() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        let etag = write_file(&dir, &pool, "/a/b/c/file.txt", Bytes::from("deep")).await.unwrap();
        assert!(tmp.path().join("a/b/c/file.txt").exists());
    }

    #[tokio::test]
    async fn test_write_file_empty() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        let etag = write_file(&dir, &pool, "/empty.txt", Bytes::new()).await.unwrap();
        assert!(tmp.path().join("empty.txt").exists());
        let meta = tokio::fs::metadata(tmp.path().join("empty.txt")).await.unwrap();
        assert_eq!(meta.len(), 0);
    }

    #[tokio::test]
    async fn test_write_file_large() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        // 写入 1MB 数据
        let data = Bytes::from(vec![0u8; 1024 * 1024]);
        let etag = write_file(&dir, &pool, "/large.bin", data).await.unwrap();
        let meta = tokio::fs::metadata(tmp.path().join("large.bin")).await.unwrap();
        assert_eq!(meta.len(), 1024 * 1024);
    }

    // ---- read_file 测试 ----

    #[tokio::test]
    async fn test_read_file_existing() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        tokio::fs::write(tmp.path().join("test.txt"), "content").await.unwrap();
        let path = read_file(&dir, "/test.txt").await.unwrap();
        assert!(path.is_file());
    }

    #[tokio::test]
    async fn test_read_file_not_found() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        let result = read_file(&dir, "/nonexistent.txt").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("不存在"));
    }

    #[tokio::test]
    async fn test_read_file_is_directory() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        tokio::fs::create_dir(tmp.path().join("mydir")).await.unwrap();
        let result = read_file(&dir, "/mydir").await;
        assert!(result.is_err());
    }

    // ---- delete_entry 测试 ----

    #[tokio::test]
    async fn test_delete_file() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        create_entry(&dir, &pool, "/del.txt", false).await.unwrap();
        delete_entry(&dir, &pool, "/del.txt").await.unwrap();
        assert!(!tmp.path().join("del.txt").exists());
    }

    #[tokio::test]
    async fn test_delete_directory() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        create_entry(&dir, &pool, "/delme", true).await.unwrap();
        write_file(&dir, &pool, "/delme/file.txt", Bytes::from("x")).await.unwrap();
        delete_entry(&dir, &pool, "/delme").await.unwrap();
        assert!(!tmp.path().join("delme").exists());
    }

    #[tokio::test]
    async fn test_delete_nonexistent() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        let result = delete_entry(&dir, &pool, "/nope.txt").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("不存在"));
    }

    // ---- rename_entry 测试 ----

    #[tokio::test]
    async fn test_rename_file() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        write_file(&dir, &pool, "/old.txt", Bytes::from("data")).await.unwrap();
        rename_entry(&dir, &pool, "/old.txt", "/new.txt").await.unwrap();
        assert!(!tmp.path().join("old.txt").exists());
        assert!(tmp.path().join("new.txt").exists());
    }

    #[tokio::test]
    async fn test_rename_to_existing_target() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        write_file(&dir, &pool, "/a.txt", Bytes::from("a")).await.unwrap();
        write_file(&dir, &pool, "/b.txt", Bytes::from("b")).await.unwrap();
        let result = rename_entry(&dir, &pool, "/a.txt", "/b.txt").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("已存在"));
    }

    #[tokio::test]
    async fn test_rename_nonexistent_source() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        let result = rename_entry(&dir, &pool, "/nope.txt", "/target.txt").await;
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("不存在"));
    }

    // ---- list_dir 测试 ----

    #[tokio::test]
    async fn test_list_dir_empty() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        let result = list_dir(&dir, &pool, "/").await.unwrap();
        assert_eq!(result.items.len(), 0);
    }

    #[tokio::test]
    async fn test_list_dir_with_files_and_dirs() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        create_entry(&dir, &pool, "/subdir", true).await.unwrap();
        write_file(&dir, &pool, "/file1.txt", Bytes::from("a")).await.unwrap();
        write_file(&dir, &pool, "/file2.txt", Bytes::from("b")).await.unwrap();

        let result = list_dir(&dir, &pool, "/").await.unwrap();
        // 目录优先排序：subdir, file1.txt, file2.txt
        assert_eq!(result.items.len(), 3);
        assert_eq!(result.items[0].item_type, "directory");
        assert_eq!(result.items[0].name, "subdir");
        assert_eq!(result.items[1].item_type, "file");
    }

    #[tokio::test]
    async fn test_list_dir_not_a_directory() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        write_file(&dir, &pool, "/file.txt", Bytes::from("x")).await.unwrap();
        let result = list_dir(&dir, &pool, "/file.txt").await;
        assert!(result.is_err());
    }

    // ---- get_file_info 测试 ----

    #[tokio::test]
    async fn test_get_file_info_existing() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        write_file(&dir, &pool, "/info.txt", Bytes::from("hello")).await.unwrap();
        let meta = get_file_info(&dir, &pool, "/info.txt").await.unwrap();
        assert_eq!(meta.path, "/info.txt");
        assert!(!meta.is_dir);
        assert_eq!(meta.size, 5);
    }

    #[tokio::test]
    async fn test_get_file_info_nonexistent() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        let result = get_file_info(&dir, &pool, "/nope.txt").await;
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn test_get_file_info_disk_only_no_db() {
        let (tmp, pool) = setup().await;
        let dir = data_dir(&tmp);

        // 直接在磁盘创建文件（绕过 file_ops）
        tokio::fs::write(tmp.path().join("orphan.txt"), "orphan data").await.unwrap();

        // get_file_info 应该能自动同步
        let meta = get_file_info(&dir, &pool, "/orphan.txt").await.unwrap();
        assert_eq!(meta.path, "/orphan.txt");
        assert_eq!(meta.size, 11);
    }
}
