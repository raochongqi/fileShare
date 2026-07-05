// Tauri 应用入口
// 薄壳层：只负责注册 Tauri 命令，核心逻辑在 lib.rs

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use fileshare_client::{extract_file_name, download_file_to, watch_and_upload_on_close, ClientConfig, OpenFileParams, OpenFileResult, WatchContext};

#[tauri::command]
async fn open_file_for_edit(
    _app: tauri::AppHandle,
    params: OpenFileParams,
) -> Result<OpenFileResult, String> {
    let config = ClientConfig::load();

    // 提取文件名
    let file_name = extract_file_name(&params.path);
    let local_path = config.temp_dir.join(&file_name);

    // 从服务端下载文件
    let client = reqwest::Client::new();
    download_file_to(&client, &config, &params.path, &local_path).await?;

    // 启动 inotify 监听（后台线程）
    let watch_path = local_path.clone();
    let server_path = params.path.clone();
    let lock_token = params.lock_token.clone();
    let server_url = config.server_url.clone();
    let auth_token = config.auth_token.clone();

    std::thread::spawn(move || {
        watch_and_upload_on_close(WatchContext {
            watch_path,
            server_path,
            lock_token,
            server_url,
            auth_token,
        });
    });

    // 用系统默认应用打开文件
    open::that(&local_path).map_err(|e| format!("打开文件失败: {}", e))?;

    Ok(OpenFileResult {
        local_path: local_path.to_string_lossy().to_string(),
        file_name,
    })
}

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![open_file_for_edit])
        .setup(|app| {
            // 启动时自动打开 DevTools（右键菜单也可 "检查元素"）
            let window = app.get_window("main").expect("找不到主窗口");
            window.open_devtools();
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动 Tauri 应用失败");
}
