use axum::{middleware, routing::*, Router};
use tower_http::cors::{CorsLayer, Any};
use crate::handler::{auth, events, files, lock};
use crate::handler::files::AppState;

/// 构建 HTTP 路由
pub fn build_router(state: AppState) -> Router {
    let config = state.config.clone();

    // CORS：允许 Tauri webview（tauri://localhost）等跨域请求
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        // SSE 事件流
        .route("/api/events", get(events::sse_events))
        // 文件 CRUD
        .route("/api/files", get(files::list_files).post(files::create_entry).delete(files::delete_entry).patch(files::rename_entry))
        .route("/api/files/content", get(files::download_file).put(files::upload_file))
        .route("/api/files/info", get(files::get_file_info))
        .route("/api/files/search", get(files::search_files))
        // 锁操作
        .route("/api/files/lock", post(lock::acquire_lock).get(lock::query_lock).delete(lock::release_lock))
        .route("/api/files/lock/lease", put(lock::renew_lock))
        // CORS 层（在认证中间件之前，确保预检请求不被拦截）
        .layer(cors)
        // Bearer Token 认证中间件
        .layer(middleware::from_fn_with_state(config, auth::auth_middleware))
        .with_state(state)
}
