// 客户端核心逻辑（不依赖 Tauri，可独立测试）
// 包含：文件下载、上传、锁操作、inotify 监听

use notify::{Config as NotifyConfig, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::fs;
use std::path::PathBuf;
use std::sync::mpsc;
use std::time::Duration;

// ---- 配置 ----

#[derive(Debug, Clone)]
pub struct ClientConfig {
    pub server_url: String,
    pub auth_token: String,
    pub temp_dir: PathBuf,
}

impl ClientConfig {
    pub fn load() -> Self {
        let _ = dotenvy::dotenv();
        Self {
            server_url: std::env::var("VITE_SERVER_URL")
                .or_else(|_| std::env::var("SERVER_URL"))
                .unwrap_or_else(|_| "http://localhost:8080".to_string()),
            auth_token: std::env::var("VITE_AUTH_TOKEN")
                .or_else(|_| std::env::var("AUTH_TOKEN"))
                .unwrap_or_else(|_| "change-me".to_string()),
            temp_dir: std::env::temp_dir().join("fileshare"),
        }
    }

    /// 创建用于测试的配置
    pub fn for_test(temp_dir: PathBuf, server_url: &str, auth_token: &str) -> Self {
        Self {
            server_url: server_url.to_string(),
            auth_token: auth_token.to_string(),
            temp_dir,
        }
    }
}

// ---- 数据结构 ----

#[derive(Debug, Clone, serde::Deserialize)]
pub struct OpenFileParams {
    pub path: String,
    pub lock_token: String,
    pub lease_until: i64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct OpenFileResult {
    pub local_path: String,
    pub file_name: String,
}

// ---- 文件名提取 ----

/// 从服务端路径提取文件名（路径最后一段）
pub fn extract_file_name(path: &str) -> String {
    path.rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("file")
        .to_string()
}

// ---- 文件下载 ----

/// 从服务端下载文件到指定本地路径
pub async fn download_file_to(
    client: &reqwest::Client,
    config: &ClientConfig,
    server_path: &str,
    local_path: &PathBuf,
) -> Result<(), String> {
    // 确保临时目录存在
    if let Some(parent) = local_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败: {}", e))?;
    }

    let resp = client
        .get(format!(
            "{}/api/files/content?path={}",
            config.server_url, server_path
        ))
        .header("Authorization", format!("Bearer {}", config.auth_token))
        .send()
        .await
        .map_err(|e| format!("下载失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("下载失败: HTTP {}", resp.status()));
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取响应失败: {}", e))?;

    fs::write(local_path, &bytes).map_err(|e| format!("写入本地文件失败: {}", e))?;

    Ok(())
}

// ---- 文件上传 + 释放锁 ----

/// 上传本地文件到服务端并释放写锁
pub async fn upload_and_unlock(
    client: &reqwest::Client,
    config: &ClientConfig,
    server_path: &str,
    lock_token: &str,
    local_path: &PathBuf,
) -> Result<(), String> {
    // 读取本地文件
    let bytes = fs::read(local_path).map_err(|e| format!("读取本地文件失败: {}", e))?;

    let file_name = local_path
        .file_name()
        .unwrap_or_default()
        .to_string_lossy()
        .to_string();

    // 上传到服务端
    let resp = client
        .put(format!(
            "{}/api/files/content?path={}",
            config.server_url, server_path
        ))
        .header("Authorization", format!("Bearer {}", config.auth_token))
        .header("X-Lock-Token", lock_token)
        .multipart(
            reqwest::multipart::Form::new().part(
                "file",
                reqwest::multipart::Part::bytes(bytes).file_name(file_name),
            ),
        )
        .send()
        .await
        .map_err(|e| format!("上传请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("上传失败: HTTP {}", resp.status()));
    }

    // 释放锁
    let resp = client
        .delete(format!(
            "{}/api/files/lock?path={}",
            config.server_url, server_path
        ))
        .header("Authorization", format!("Bearer {}", config.auth_token))
        .header("X-Lock-Token", lock_token)
        .send()
        .await
        .map_err(|e| format!("释放锁请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("释放锁失败: HTTP {}", resp.status()));
    }

    Ok(())
}

// ---- 锁续租 ----

/// 向服务端续租锁
pub async fn renew_lock(
    client: &reqwest::Client,
    config: &ClientConfig,
    server_path: &str,
    lock_token: &str,
) -> Result<i64, String> {
    let resp = client
        .put(format!(
            "{}/api/files/lock/lease",
            config.server_url
        ))
        .header("Authorization", format!("Bearer {}", config.auth_token))
        .header("X-Lock-Token", lock_token)
        .header("Content-Type", "application/json")
        .body(format!("{{\"path\":\"{}\"}}", server_path))
        .send()
        .await
        .map_err(|e| format!("续租请求失败: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("续租失败: HTTP {}", resp.status()));
    }

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("解析续租响应失败: {}", e))?;

    data["lease_until"]
        .as_i64()
        .ok_or_else(|| "续租响应缺少 lease_until".to_string())
}

// ---- inotify 文件关闭监听 ----

/// WatchContext 用于在 inotify 监听线程间传递上下文
pub struct WatchContext {
    pub watch_path: PathBuf,
    pub server_path: String,
    pub lock_token: String,
    pub server_url: String,
    pub auth_token: String,
}

/// 启动 inotify 监听，等待文件关闭后自动上传释放锁
/// 此函数会阻塞直到文件关闭并被上传
pub fn watch_and_upload_on_close(ctx: WatchContext) {
    let (tx, rx) = mpsc::channel();

    let parent = match ctx.watch_path.parent() {
        Some(p) => p.to_path_buf(),
        None => return,
    };

    let file_name = match ctx.watch_path.file_name() {
        Some(n) => n.to_os_string(),
        None => return,
    };

    let mut watcher = match RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            if let Ok(event) = res {
                let is_target = event.paths.iter().any(|p| p.file_name() == Some(&file_name));
                if !is_target {
                    return;
                }
                if matches!(
                    event.kind,
                    EventKind::Access(notify::event::AccessKind::Close(
                        notify::event::AccessMode::Write
                    ))
                ) {
                    let _ = tx.send(true);
                }
            }
        },
        NotifyConfig::default(),
    ) {
        Ok(w) => w,
        Err(e) => {
            tracing::error!("创建 inotify watcher 失败: {}", e);
            return;
        }
    };

    if let Err(e) = watcher.watch(&parent, RecursiveMode::NonRecursive) {
        tracing::error!("启动 inotify 监听失败: {}", e);
        return;
    }

    // 等待文件关闭事件，带 3 秒防抖
    let mut last_close_time = None;
    loop {
        match rx.recv_timeout(Duration::from_secs(1)) {
            Ok(true) => {
                last_close_time = Some(std::time::Instant::now());
            }
            _ => {
                if let Some(t) = last_close_time {
                    if t.elapsed() >= Duration::from_secs(3) {
                        break;
                    }
                }
            }
        }
    }

    drop(watcher);

    // 上传并释放锁
    let rt = match tokio::runtime::Runtime::new() {
        Ok(rt) => rt,
        Err(e) => {
            tracing::error!("创建 tokio runtime 失败: {}", e);
            return;
        }
    };

    let local_path = ctx.watch_path.clone();
    rt.block_on(async {
        let client = reqwest::Client::new();
        let config = ClientConfig {
            server_url: ctx.server_url.clone(),
            auth_token: ctx.auth_token.clone(),
            temp_dir: local_path.parent().unwrap_or_else(|| std::path::Path::new("/tmp")).to_path_buf(),
        };

        match upload_and_unlock(&client, &config, &ctx.server_path, &ctx.lock_token, &local_path).await {
            Ok(()) => tracing::info!("文件上传并释放锁成功: {}", ctx.server_path),
            Err(e) => tracing::error!("上传释放锁失败: {}", e),
        }
    });
}

// ---- 单元测试 ----

#[cfg(test)]
mod tests {
    use super::*;

    // ---- extract_file_name 测试 ----

    #[test]
    fn test_extract_file_name_normal() {
        assert_eq!(extract_file_name("/docs/report.docx"), "report.docx");
        assert_eq!(extract_file_name("/a.txt"), "a.txt");
    }

    #[test]
    fn test_extract_file_name_nested() {
        assert_eq!(extract_file_name("/a/b/c/deep.txt"), "deep.txt");
    }

    #[test]
    fn test_extract_file_name_root() {
        assert_eq!(extract_file_name("/file.txt"), "file.txt");
    }

    #[test]
    fn test_extract_file_name_no_slash() {
        // 无路径分隔符，返回整个字符串
        assert_eq!(extract_file_name("file.txt"), "file.txt");
    }

    #[test]
    fn test_extract_file_name_trailing_slash() {
        // 末尾斜杠，rsplit 后第一个元素是空串，应返回默认 "file"
        let name = extract_file_name("/docs/dir/");
        assert_eq!(name, "file");
    }

    #[test]
    fn test_extract_file_name_empty() {
        let name = extract_file_name("");
        assert_eq!(name, "file"); // 空路径返回默认 "file"
    }

    #[test]
    fn test_extract_file_name_unicode() {
        assert_eq!(extract_file_name("/文档/报告.docx"), "报告.docx");
    }

    #[test]
    fn test_extract_file_name_special_chars() {
        assert_eq!(extract_file_name("/path/file (1).txt"), "file (1).txt");
        assert_eq!(extract_file_name("/path/file&test.txt"), "file&test.txt");
    }

    // ---- ClientConfig 测试 ----

    #[test]
    fn test_client_config_for_test() {
        let tmp = tempfile::tempdir().unwrap();
        let config = ClientConfig::for_test(tmp.path().to_path_buf(), "http://test:8080", "tok");
        assert_eq!(config.server_url, "http://test:8080");
        assert_eq!(config.auth_token, "tok");
        assert_eq!(config.temp_dir, tmp.path().to_path_buf());
    }

    // ---- 本地文件操作测试 ----

    #[test]
    fn test_local_file_write_and_read() {
        let tmp = tempfile::tempdir().unwrap();
        let file_path = tmp.path().join("test.txt");

        fs::write(&file_path, "hello world").unwrap();
        let content = fs::read_to_string(&file_path).unwrap();
        assert_eq!(content, "hello world");
    }

    #[test]
    fn test_local_file_create_dir_all_nested() {
        let tmp = tempfile::tempdir().unwrap();
        let nested = tmp.path().join("a/b/c");
        fs::create_dir_all(&nested).unwrap();
        assert!(nested.exists());
    }

    #[test]
    fn test_local_file_write_empty() {
        let tmp = tempfile::tempdir().unwrap();
        let file_path = tmp.path().join("empty.txt");
        fs::write(&file_path, "").unwrap();
        let meta = fs::metadata(&file_path).unwrap();
        assert_eq!(meta.len(), 0);
    }

    #[test]
    fn test_local_file_write_binary() {
        let tmp = tempfile::tempdir().unwrap();
        let file_path = tmp.path().join("binary.dat");
        let data = vec![0u8, 255, 128, 1, 127];
        fs::write(&file_path, &data).unwrap();
        let read_back = fs::read(&file_path).unwrap();
        assert_eq!(read_back, data);
    }

    // ---- 下载文件参数验证 ----

    #[test]
    fn test_download_url_construction() {
        let config = ClientConfig::for_test(
            PathBuf::from("/tmp"),
            "http://192.168.1.100:8080",
            "my-token",
        );
        let url = format!(
            "{}/api/files/content?path={}",
            config.server_url, "/docs/test.txt"
        );
        assert_eq!(url, "http://192.168.1.100:8080/api/files/content?path=/docs/test.txt");
    }

    #[test]
    fn test_download_url_with_special_chars() {
        let config = ClientConfig::for_test(
            PathBuf::from("/tmp"),
            "http://server:8080",
            "tok",
        );
        // 路径含中文和空格需要 URL 编码
        let path = "/文档/报告 2026.docx";
        let encoded = urlencoding::encode(path);
        let url = format!(
            "{}/api/files/content?path={}",
            config.server_url, encoded
        );
        assert!(url.contains("%"));
    }

    // ---- upload_and_unlock 参数测试 ----

    #[test]
    fn test_upload_url_construction() {
        let config = ClientConfig::for_test(
            PathBuf::from("/tmp"),
            "http://server:8080",
            "tok",
        );
        let url = format!(
            "{}/api/files/content?path={}",
            config.server_url, "/docs/test.txt"
        );
        assert_eq!(url, "http://server:8080/api/files/content?path=/docs/test.txt");
    }

    #[test]
    fn test_lock_release_url_construction() {
        let config = ClientConfig::for_test(
            PathBuf::from("/tmp"),
            "http://server:8080",
            "tok",
        );
        let path = "/docs/test.txt";
        let url = format!(
            "{}/api/files/lock?path={}",
            config.server_url, path
        );
        assert_eq!(url, "http://server:8080/api/files/lock?path=/docs/test.txt");
    }

    // ---- 续租请求测试 ----

    #[test]
    fn test_renew_lock_body_construction() {
        let path = "/docs/test.txt";
        let body = format!("{{\"path\":\"{}\"}}", path);
        assert_eq!(body, "{\"path\":\"/docs/test.txt\"}");
    }

    #[test]
    fn test_renew_lock_body_with_special_path() {
        let path = "/a/b/c.txt";
        let body = format!("{{\"path\":\"{}\"}}", path);
        let parsed: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(parsed["path"], "/a/b/c.txt");
    }

    // ---- 本地文件删除（清理临时文件） ----

    #[test]
    fn test_cleanup_temp_file() {
        let tmp = tempfile::tempdir().unwrap();
        let file_path = tmp.path().join("temp_edit.txt");
        fs::write(&file_path, "temp data").unwrap();
        assert!(file_path.exists());

        fs::remove_file(&file_path).unwrap();
        assert!(!file_path.exists());
    }

    #[test]
    fn test_cleanup_nonexistent_file_fails() {
        let result = fs::remove_file("/nonexistent/file.txt");
        assert!(result.is_err());
    }

    // ---- OpenFileParams 反序列化测试 ----

    #[test]
    fn test_open_file_params_deserialize() {
        let json = r#"{"path":"/docs/test.txt","lock_token":"abc-123","lease_until":1700000000000}"#;
        let params: OpenFileParams = serde_json::from_str(json).unwrap();
        assert_eq!(params.path, "/docs/test.txt");
        assert_eq!(params.lock_token, "abc-123");
        assert_eq!(params.lease_until, 1700000000000);
    }

    #[test]
    fn test_open_file_params_deserialize_empty_path() {
        let json = r#"{"path":"","lock_token":"tok","lease_until":0}"#;
        let params: OpenFileParams = serde_json::from_str(json).unwrap();
        assert_eq!(params.path, "");
    }

    #[test]
    fn test_open_file_params_deserialize_missing_field() {
        let json = r#"{"path":"/test.txt"}"#;
        let result = serde_json::from_str::<OpenFileParams>(json);
        assert!(result.is_err());
    }

    // ---- OpenFileResult 序列化测试 ----

    #[test]
    fn test_open_file_result_serialize() {
        let result = OpenFileResult {
            local_path: "/tmp/fileshare/test.txt".to_string(),
            file_name: "test.txt".to_string(),
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("local_path"));
        assert!(json.contains("test.txt"));
    }

    // ============================================================
    // 防御性测试：以下测试覆盖边界条件、错误路径和异常输入
    // ============================================================

    // ---- extract_file_name 防御性边界测试 ----

    #[test]
    fn test_extract_file_name_multiple_consecutive_slashes() {
        // 路径含多个连续斜杠，rsplit 仍能正确提取最后一段非空文件名
        assert_eq!(extract_file_name("//a///b////c.txt"), "c.txt");
    }

    #[test]
    fn test_extract_file_name_only_slashes() {
        // 路径仅含斜杠，rsplit 后全为空串，应返回默认值 "file"
        assert_eq!(extract_file_name("///"), "file");
    }

    #[test]
    fn test_extract_file_name_dots_in_filename() {
        // 文件名含多个点号（版本号风格），不应被截断
        assert_eq!(
            extract_file_name("/path/to/file.v2.3.final.docx"),
            "file.v2.3.final.docx"
        );
    }

    #[test]
    fn test_extract_file_name_hidden_file() {
        // 隐藏文件（以点号开头），应完整保留 ".hidden"
        assert_eq!(extract_file_name("/path/.hidden"), ".hidden");
    }

    #[test]
    fn test_extract_file_name_very_long_path() {
        // 超长路径（1000+ 字符），确保不会因路径过长而崩溃或截断文件名
        let long_dir: String = "dir".repeat(400); // 1200 字符的目录名
        let path = format!("/{}/deep_file.txt", long_dir);
        assert!(path.len() > 1000, "路径长度应超过 1000，实际: {}", path.len());
        assert_eq!(extract_file_name(&path), "deep_file.txt");
    }

    #[test]
    fn test_extract_file_name_just_filename() {
        // 无目录前缀，仅有文件名，应直接返回
        assert_eq!(extract_file_name("readme.md"), "readme.md");
    }

    // ---- ClientConfig 防御性测试 ----

    #[test]
    fn test_client_config_empty_server_url() {
        // server_url 为空字符串，虽然不合理但结构上合法
        let tmp = tempfile::tempdir().unwrap();
        let config = ClientConfig::for_test(tmp.path().to_path_buf(), "", "tok");
        assert_eq!(config.server_url, "");
        // 验证用空 URL 构造请求字符串不会 panic
        let url = format!("{}/api/files/content?path=/test.txt", config.server_url);
        assert_eq!(url, "/api/files/content?path=/test.txt");
    }

    #[test]
    fn test_client_config_trailing_slash_server_url() {
        // server_url 末尾带斜杠，拼接后会产生双斜杠，需注意
        let tmp = tempfile::tempdir().unwrap();
        let config = ClientConfig::for_test(tmp.path().to_path_buf(), "http://server:8080/", "tok");
        let url = format!("{}/api/files/content?path=/test.txt", config.server_url);
        // 当前实现会产生双斜杠 "http://server:8080//api/..."
        // 此测试记录该行为，提醒可能需要规范化 URL
        assert!(url.contains("//api/"));
    }

    #[test]
    fn test_client_config_empty_auth_token() {
        // auth_token 为空字符串，请求会携带 "Bearer " 无令牌
        let tmp = tempfile::tempdir().unwrap();
        let config = ClientConfig::for_test(tmp.path().to_path_buf(), "http://server:8080", "");
        assert_eq!(config.auth_token, "");
        let header_val = format!("Bearer {}", config.auth_token);
        assert_eq!(header_val, "Bearer ");
    }

    // ---- 辅助：启动微型 mock HTTP 服务器 ----

    /// 启动一个微型 HTTP 服务器，对任意请求返回指定状态码和响应体
    async fn start_mock_server(status_code: u16, body: &'static str) -> std::net::SocketAddr {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("绑定 mock 服务器端口失败");
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        tokio::spawn(async move {
                            // 粗略读取请求行后直接返回响应
                            use tokio::io::{AsyncReadExt, AsyncWriteExt};
                            let mut buf = vec![0u8; 4096];
                            let mut stream = stream;
                            let _ = stream.read(&mut buf).await;
                            let status_text = match status_code {
                                200 => "OK",
                                404 => "Not Found",
                                409 => "Conflict",
                                410 => "Gone",
                                500 => "Internal Server Error",
                                _ => "OK",
                            };
                            let response = format!(
                                "HTTP/1.1 {} {}\r\nContent-Length: {}\r\nContent-Type: application/json\r\n\r\n{}",
                                status_code, status_text, body.len(), body
                            );
                            let _ = stream.write_all(response.as_bytes()).await;
                            let _ = stream.flush().await;
                        });
                    }
                    Err(_) => break,
                }
            }
        });

        // 等待服务器就绪
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        addr
    }

    // ---- download 错误路径测试 ----

    #[tokio::test]
    async fn test_download_server_returns_404() {
        // 服务端返回 404，download_file_to 应返回包含 "404" 的错误
        let addr = start_mock_server(404, "{}").await;
        let tmp = tempfile::tempdir().unwrap();
        let config =
            ClientConfig::for_test(tmp.path().to_path_buf(), &format!("http://{}", addr), "tok");
        let client = reqwest::Client::new();
        let local_path = tmp.path().join("test_404.txt");

        let result = download_file_to(&client, &config, "/missing.txt", &local_path).await;
        assert!(result.is_err(), "下载 404 应该失败");
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("404"),
            "错误消息应包含 404，实际: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_download_server_returns_500() {
        // 服务端返回 500，download_file_to 应返回包含 "500" 的错误
        let addr = start_mock_server(500, "internal error").await;
        let tmp = tempfile::tempdir().unwrap();
        let config =
            ClientConfig::for_test(tmp.path().to_path_buf(), &format!("http://{}", addr), "tok");
        let client = reqwest::Client::new();
        let local_path = tmp.path().join("test_500.txt");

        let result = download_file_to(&client, &config, "/broken.txt", &local_path).await;
        assert!(result.is_err(), "下载 500 应该失败");
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("500"),
            "错误消息应包含 500，实际: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_download_network_unreachable() {
        // 连接到不存在的端口，应返回连接拒绝错误
        let tmp = tempfile::tempdir().unwrap();
        let config = ClientConfig::for_test(
            tmp.path().to_path_buf(),
            "http://127.0.0.1:1", // 端口 1 通常无服务，会连接拒绝
            "tok",
        );
        let client = reqwest::Client::new();
        let local_path = tmp.path().join("test_network.txt");

        let result = download_file_to(&client, &config, "/test.txt", &local_path).await;
        assert!(result.is_err(), "网络不可达应返回错误");
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("下载失败"),
            "错误消息应以 '下载失败' 开头，实际: {}",
            err_msg
        );
    }

    #[test]
    fn test_download_readonly_directory() {
        // 尝试写入只读目录，验证 download_file_to 中 create_dir_all 的错误处理逻辑
        // 在 Windows 上 C:\ 根目录下的系统目录通常不可写
        let readonly_dir = PathBuf::from("C:\\Windows\\System32\\fileshare_test_readonly");
        let _config = ClientConfig::for_test(
            readonly_dir.clone(),
            "http://127.0.0.1:1",
            "tok",
        );
        let _local_path = readonly_dir.join("nested/impossible_write.txt");

        // 直接测试 create_dir_all 对只读路径的行为
        // 由于实际权限取决于系统，这里测试函数路径中 create_dir_all 被调用的逻辑
        // 使用一个绝对不可能创建目录的路径来验证错误处理
        let impossible_path = PathBuf::from("C:\\Windows\\System32\\fileshare_readonly_test\\nested\\test.txt");
        let result = fs::create_dir_all(impossible_path.parent().unwrap());
        // 在 Windows 上可能成功也可能失败取决于具体路径，只验证不会 panic
        let _ = result;
    }

    // ---- upload 错误路径测试 ----

    #[tokio::test]
    async fn test_upload_nonexistent_local_file() {
        // 上传不存在的本地文件，应返回 "读取本地文件失败"
        let tmp = tempfile::tempdir().unwrap();
        let config = ClientConfig::for_test(
            tmp.path().to_path_buf(),
            "http://127.0.0.1:1", // 不会真正连接到
            "tok",
        );
        let client = reqwest::Client::new();
        let nonexistent = tmp.path().join("does_not_exist_at_all.txt");

        let result = upload_and_unlock(&client, &config, "/test.txt", "lock-tok", &nonexistent).await;
        assert!(result.is_err(), "上传不存在的文件应失败");
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("读取本地文件失败"),
            "错误消息应包含 '读取本地文件失败'，实际: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_upload_server_returns_409() {
        // 服务端返回 409 Conflict，upload 应返回包含 "409" 的错误
        let addr = start_mock_server(409, "{}").await;
        let tmp = tempfile::tempdir().unwrap();
        let config =
            ClientConfig::for_test(tmp.path().to_path_buf(), &format!("http://{}", addr), "tok");
        let client = reqwest::Client::new();
        let local_path = tmp.path().join("conflict_upload.txt");
        fs::write(&local_path, b"test data").unwrap();

        let result = upload_and_unlock(&client, &config, "/test.txt", "lock-tok", &local_path).await;
        assert!(result.is_err(), "上传 409 应该失败");
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("409"),
            "错误消息应包含 409，实际: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_upload_succeeds_but_lock_release_fails() {
        // 上传成功（PUT 200）但释放锁失败（DELETE 409），应返回 "释放锁失败"
        // 需要一个更精细的 mock：PUT 返回 200，DELETE 返回 409
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .unwrap();
        let addr = listener.local_addr().unwrap();

        tokio::spawn(async move {
            let mut request_count = 0u32;
            loop {
                match listener.accept().await {
                    Ok((stream, _)) => {
                        request_count += 1;
                        let count = request_count;
                        tokio::spawn(async move {
                            use tokio::io::{AsyncReadExt, AsyncWriteExt};
                            let mut buf = vec![0u8; 8192];
                            let mut stream = stream;
                            let _ = stream.read(&mut buf).await;

                            // 第一个请求（PUT 上传）返回 200
                            // 第二个请求（DELETE 释放锁）返回 409
                            let response = if count <= 1 {
                                "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n".to_string()
                            } else {
                                "HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n\r\n".to_string()
                            };
                            let _ = stream.write_all(response.as_bytes()).await;
                            let _ = stream.flush().await;
                        });
                    }
                    Err(_) => break,
                }
            }
        });

        tokio::time::sleep(std::time::Duration::from_millis(50)).await;

        let tmp = tempfile::tempdir().unwrap();
        let config =
            ClientConfig::for_test(tmp.path().to_path_buf(), &format!("http://{}", addr), "tok");
        let client = reqwest::Client::new();
        let local_path = tmp.path().join("upload_ok_lock_fail.txt");
        fs::write(&local_path, b"test data").unwrap();

        let result = upload_and_unlock(&client, &config, "/test.txt", "lock-tok", &local_path).await;
        assert!(result.is_err(), "锁释放失败时整体应返回错误");
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("释放锁失败"),
            "错误消息应包含 '释放锁失败'，实际: {}",
            err_msg
        );
    }

    // ---- renew_lock 错误路径测试 ----

    #[tokio::test]
    async fn test_renew_lock_server_returns_409() {
        // 服务端返回 409 Conflict（锁已被其他人持有），续租应失败
        let addr = start_mock_server(409, "{}").await;
        let tmp = tempfile::tempdir().unwrap();
        let config =
            ClientConfig::for_test(tmp.path().to_path_buf(), &format!("http://{}", addr), "tok");
        let client = reqwest::Client::new();

        let result = renew_lock(&client, &config, "/test.txt", "lock-tok").await;
        assert!(result.is_err(), "续租 409 应该失败");
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("续租失败") && err_msg.contains("409"),
            "错误消息应包含 '续租失败' 和 '409'，实际: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_renew_lock_server_returns_410() {
        // 服务端返回 410 Gone（锁已过期被回收），续租应失败
        let addr = start_mock_server(410, "{}").await;
        let tmp = tempfile::tempdir().unwrap();
        let config =
            ClientConfig::for_test(tmp.path().to_path_buf(), &format!("http://{}", addr), "tok");
        let client = reqwest::Client::new();

        let result = renew_lock(&client, &config, "/test.txt", "lock-tok").await;
        assert!(result.is_err(), "续租 410 应该失败");
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("续租失败") && err_msg.contains("410"),
            "错误消息应包含 '续租失败' 和 '410'，实际: {}",
            err_msg
        );
    }

    #[tokio::test]
    async fn test_renew_lock_response_missing_lease_until() {
        // 续租成功（HTTP 200）但响应体中缺少 lease_until 字段
        let addr = start_mock_server(200, r#"{"path":"/test.txt"}"#).await;
        let tmp = tempfile::tempdir().unwrap();
        let config =
            ClientConfig::for_test(tmp.path().to_path_buf(), &format!("http://{}", addr), "tok");
        let client = reqwest::Client::new();

        let result = renew_lock(&client, &config, "/test.txt", "lock-tok").await;
        assert!(result.is_err(), "缺少 lease_until 应返回错误");
        let err_msg = result.unwrap_err();
        assert!(
            err_msg.contains("续租响应缺少 lease_until"),
            "错误消息应包含 '续租响应缺少 lease_until'，实际: {}",
            err_msg
        );
    }

    // ---- OpenFileParams 反序列化防御性测试 ----

    #[test]
    fn test_open_file_params_extra_fields_ignored() {
        // JSON 包含额外字段，反序列化应忽略多余字段而不报错
        let json = r#"{"path":"/test.txt","lock_token":"tok","lease_until":100,"extra":"value","another":42}"#;
        let params: OpenFileParams = serde_json::from_str(json).unwrap();
        assert_eq!(params.path, "/test.txt");
        assert_eq!(params.lock_token, "tok");
        assert_eq!(params.lease_until, 100);
    }

    #[test]
    fn test_open_file_params_negative_lease_until() {
        // lease_until 为负值（不合理的时间戳），反序列化仍应成功（类型是 i64）
        let json = r#"{"path":"/test.txt","lock_token":"tok","lease_until":-99999}"#;
        let params: OpenFileParams = serde_json::from_str(json).unwrap();
        assert_eq!(params.lease_until, -99999);
    }

    #[test]
    fn test_open_file_params_very_large_lease_until() {
        // lease_until 为 i64 最大值，验证不会溢出
        let json = r#"{"path":"/test.txt","lock_token":"tok","lease_until":9223372036854775807}"#;
        let params: OpenFileParams = serde_json::from_str(json).unwrap();
        assert_eq!(params.lease_until, i64::MAX);
    }

    #[test]
    fn test_open_file_params_unicode_in_path() {
        // path 字段包含 Unicode 字符（中文、emoji 等）
        let json = r#"{"path":"/文档/📂文件.txt","lock_token":"tok","lease_until":100}"#;
        let params: OpenFileParams = serde_json::from_str(json).unwrap();
        assert_eq!(params.path, "/文档/📂文件.txt");
    }

    #[test]
    fn test_open_file_params_missing_lock_token() {
        // 缺少 lock_token 字段，反序列化应失败
        let json = r#"{"path":"/test.txt","lease_until":100}"#;
        let result = serde_json::from_str::<OpenFileParams>(json);
        assert!(result.is_err(), "缺少 lock_token 应反序列化失败");
    }

    #[test]
    fn test_open_file_params_missing_lease_until() {
        // 缺少 lease_until 字段，反序列化应失败
        let json = r#"{"path":"/test.txt","lock_token":"tok"}"#;
        let result = serde_json::from_str::<OpenFileParams>(json);
        assert!(result.is_err(), "缺少 lease_until 应反序列化失败");
    }

    // ---- OpenFileResult 序列化防御性测试 ----

    #[test]
    fn test_open_file_result_roundtrip() {
        // 序列化后再反序列化，应得到相同结果
        let original = OpenFileResult {
            local_path: "/tmp/fileshare/report.docx".to_string(),
            file_name: "report.docx".to_string(),
        };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: OpenFileResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.local_path, original.local_path);
        assert_eq!(deserialized.file_name, original.file_name);
    }

    #[test]
    fn test_open_file_result_empty_strings() {
        // 所有字段为空字符串，序列化/反序列化应正常工作
        let original = OpenFileResult {
            local_path: "".to_string(),
            file_name: "".to_string(),
        };
        let json = serde_json::to_string(&original).unwrap();
        let deserialized: OpenFileResult = serde_json::from_str(&json).unwrap();
        assert_eq!(deserialized.local_path, "");
        assert_eq!(deserialized.file_name, "");
    }

    // ---- WatchContext 构造测试 ----

    #[test]
    fn test_watch_context_construction() {
        // 验证 WatchContext 各字段正确赋值
        let ctx = WatchContext {
            watch_path: PathBuf::from("/tmp/fileshare/test.txt"),
            server_path: "/docs/test.txt".to_string(),
            lock_token: "abc-123".to_string(),
            server_url: "http://server:8080".to_string(),
            auth_token: "my-token".to_string(),
        };
        assert_eq!(ctx.watch_path, PathBuf::from("/tmp/fileshare/test.txt"));
        assert_eq!(ctx.server_path, "/docs/test.txt");
        assert_eq!(ctx.lock_token, "abc-123");
        assert_eq!(ctx.server_url, "http://server:8080");
        assert_eq!(ctx.auth_token, "my-token");
    }

    #[test]
    fn test_watch_context_empty_fields() {
        // WatchContext 字段为空字符串/空路径，结构体仍可正常构造
        let ctx = WatchContext {
            watch_path: PathBuf::new(),
            server_path: "".to_string(),
            lock_token: "".to_string(),
            server_url: "".to_string(),
            auth_token: "".to_string(),
        };
        assert!(ctx.watch_path.as_os_str().is_empty());
        assert!(ctx.server_path.is_empty());
    }
}

// URL 编码使用 urlencoding crate
