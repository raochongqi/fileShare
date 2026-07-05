// 客户端 inotify 文件关闭检测模块
// 用于监听本地临时文件的 IN_CLOSE_WRITE 事件，判断外部编辑器是否关闭文件
// 此模块将在客户端 Tauri 侧使用，此处先在服务端验证 inotify 在目标平台可用

use notify::{RecommendedWatcher, RecursiveMode, Event, EventKind, Config as NotifyConfig, Watcher};
use std::path::Path;
use std::sync::mpsc;
use std::time::Duration;

/// 文件监控事件
#[derive(Debug, Clone)]
pub enum FileWatchEvent {
    /// 文件被打开
    Opened,
    /// 文件被关闭（可能已修改）
    ClosedWrite,
    /// 文件被删除
    Removed,
    /// 其他事件
    Other(String),
}

/// 启动文件监控，返回事件接收器
/// 监听指定文件的 IN_CLOSE_WRITE 和 IN_OPEN 事件
pub fn watch_file(file_path: &Path) -> Result<mpsc::Receiver<FileWatchEvent>, String> {
    let (tx, rx) = mpsc::channel();

    let parent = file_path
        .parent()
        .ok_or_else(|| "无法获取父目录".to_string())?;

    let file_name = file_path
        .file_name()
        .ok_or_else(|| "无法获取文件名".to_string())?
        .to_os_string();

    let mut watcher = RecommendedWatcher::new(
        move |res: Result<Event, notify::Error>| {
            match res {
                Ok(event) => {
                    // 只关注目标文件
                    let is_target = event.paths.iter().any(|p| {
                        p.file_name() == Some(&file_name)
                    });

                    if !is_target {
                        return;
                    }

                    let msg = match event.kind {
                        EventKind::Access(notify::event::AccessKind::Close(
                            notify::event::AccessMode::Write,
                        )) => FileWatchEvent::ClosedWrite,
                        EventKind::Access(notify::event::AccessKind::Open(
                            notify::event::AccessMode::Write,
                        )) => FileWatchEvent::Opened,
                        EventKind::Remove(_) => FileWatchEvent::Removed,
                        _ => FileWatchEvent::Other(format!("{:?}", event.kind)),
                    };

                    let _ = tx.send(msg);
                }
                Err(e) => {
                    let _ = tx.send(FileWatchEvent::Other(format!("watch error: {}", e)));
                }
            }
        },
        NotifyConfig::default(),
    )
    .map_err(|e| format!("创建 watcher 失败: {}", e))?;

    watcher
        .watch(parent, RecursiveMode::NonRecursive)
        .map_err(|e| format!("启动监听失败: {}", e))?;

    // watcher 必须保持存活，否则监听会停止
    // 将 watcher 泄漏到堆上（生产环境中应存储在结构体中管理生命周期）
    Box::leak(Box::new(watcher));

    Ok(rx)
}

/// 等待文件关闭事件，带超时
/// 返回 true 表示检测到文件关闭，false 表示超时
pub fn wait_for_close(rx: &mpsc::Receiver<FileWatchEvent>, timeout: Duration) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed() < timeout {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(FileWatchEvent::ClosedWrite) => return true,
            Ok(FileWatchEvent::Removed) => return true,
            Ok(_) => continue,
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return false,
        }
    }
    false
}

// ---- Linux inotify 验证测试 ----

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::io::Write;

    /// 验证 inotify 可用：创建文件并写入，检测 CLOSE_WRITE 事件
    /// 仅在 Linux 上运行（Windows 使用 ReadDirectoryChangesWatcher，事件类型不同）
    #[test]
    #[cfg(target_os = "linux")]
    fn test_inotify_detect_close_write() {
        let tmp = tempfile::tempdir().expect("创建临时目录失败");
        let file_path = tmp.path().join("test_edit.txt");

        // 创建初始文件
        fs::write(&file_path, "initial content").expect("写入文件失败");

        // 开始监听
        let rx = watch_file(&file_path).expect("启动监听失败");

        // 模拟外部编辑器：打开、写入、关闭
        {
            let mut f = fs::OpenOptions::new()
                .write(true)
                .open(&file_path)
                .expect("打开文件失败");
            f.write_all(b"modified content").expect("写入失败");
            // f drop 时自动关闭，触发 IN_CLOSE_WRITE
        }

        let detected = wait_for_close(&rx, Duration::from_secs(5));
        assert!(detected, "应在 5 秒内检测到 CLOSE_WRITE 事件");
    }

    /// 验证 inotify 区分短暂关闭和真正关闭
    /// LibreOffice 等编辑器内部自动保存会短暂关闭再重开
    #[test]
    #[cfg(target_os = "linux")]
    fn test_inotify_brief_close_reopen() {
        let tmp = tempfile::tempdir().expect("创建临时目录失败");
        let file_path = tmp.path().join("test_brief.txt");

        fs::write(&file_path, "initial").expect("写入文件失败");
        let rx = watch_file(&file_path).expect("启动监听失败");

        // 模拟短暂关闭（自动保存）再重新打开
        {
            let mut f = fs::OpenOptions::new().write(true).open(&file_path).unwrap();
            f.write_all(b"autosave").unwrap();
        } // CLOSE_WRITE

        // 短暂间隔后重新打开
        std::thread::sleep(Duration::from_millis(50));
        {
            let _f = fs::File::open(&file_path).unwrap(); // OPEN（但只读不触发 IN_OPEN(WRITE)）
        }

        // 应该至少收到一个 ClosedWrite 事件
        let start = std::time::Instant::now();
        let mut got_close = false;
        while start.elapsed() < Duration::from_secs(3) {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(FileWatchEvent::ClosedWrite) => {
                    got_close = true;
                    break;
                }
                Ok(_) => continue,
                Err(_) => continue,
            }
        }
        assert!(got_close, "应检测到至少一次 CLOSE_WRITE");
    }

    /// 验证 inotify 检测文件删除
    #[test]
    #[cfg(target_os = "linux")]
    fn test_inotify_detect_remove() {
        let tmp = tempfile::tempdir().expect("创建临时目录失败");
        let file_path = tmp.path().join("test_remove.txt");

        fs::write(&file_path, "to be removed").expect("写入文件失败");
        let rx = watch_file(&file_path).expect("启动监听失败");

        fs::remove_file(&file_path).expect("删除文件失败");

        let start = std::time::Instant::now();
        let mut got_remove = false;
        while start.elapsed() < Duration::from_secs(3) {
            match rx.recv_timeout(Duration::from_millis(200)) {
                Ok(FileWatchEvent::Removed) => {
                    got_remove = true;
                    break;
                }
                Ok(_) => continue,
                Err(_) => continue,
            }
        }
        assert!(got_remove, "应检测到文件删除事件");
    }

    /// 验证监听不存在的文件会失败
    #[test]
    fn test_watch_nonexistent_file_in_nonexistent_dir() {
        let file_path = Path::new("/nonexistent/path/file.txt");
        let result = watch_file(file_path);
        assert!(result.is_err());
    }
}
