use axum::{
    extract::{Multipart, Query, State},
    http::{header, StatusCode},
    response::{IntoResponse, Json, Response},
};
use bytes::Bytes;
use serde::Deserialize;
use sqlx::SqlitePool;
use tokio::fs::File;
use tokio_util::io::ReaderStream;

use crate::config::Config;
use crate::service::file_ops;

/// 应用共享状态
#[derive(Clone)]
pub struct AppState {
    pub pool: SqlitePool,
    pub config: Config,
    pub broadcaster: crate::handler::events::EventBroadcaster,
}

// ---- 查询参数 ----

#[derive(Debug, Deserialize)]
pub struct PathQuery {
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
}

// ---- 文件 CRUD handler ----

/// GET /api/files - 目录浏览
pub async fn list_files(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<crate::model::file::FileListResponse>, Response> {
    let path = query.path.unwrap_or_else(|| "/".to_string());
    let result = file_ops::list_dir(&state.config.data_dir, &state.pool, &path)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e).into_response())?;
    Ok(Json(result))
}

/// GET /api/files/content - 文件下载（流式）
pub async fn download_file(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Response, Response> {
    let path = query.path.ok_or_else(|| {
        (StatusCode::BAD_REQUEST, "缺少 path 参数".to_string()).into_response()
    })?;

    let file_path = file_ops::read_file(&state.config.data_dir, &path)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e).into_response())?;

    let file = File::open(&file_path).await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
    })?;

    let meta = file.metadata().await.map_err(|e| {
        (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response()
    })?;

    let mime_type = file_ops::guess_mime_static(&path);
    let stream = ReaderStream::new(file);

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_type)
        .header(header::CONTENT_LENGTH, meta.len())
        .body(axum::body::Body::from_stream(stream))
        .unwrap())
}

/// PUT /api/files/content - 文件上传
pub async fn upload_file(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
    multipart: Multipart,
) -> Result<Json<serde_json::Value>, Response> {
    let path = query.path.ok_or_else(|| {
        (StatusCode::BAD_REQUEST, "缺少 path 参数".to_string()).into_response()
    })?;

    let data: Bytes = extract_multipart_data(multipart).await?;

    let etag = file_ops::write_file(&state.config.data_dir, &state.pool, &path, data)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e).into_response())?;

    state.broadcaster.send(crate::handler::events::FileEvent::Updated {
        path: path.clone(),
        etag: etag.clone(),
    });

    Ok(Json(serde_json::json!({ "etag": etag })))
}

/// POST /api/files - 新建文件或目录
pub async fn create_entry(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<serde_json::Value>, Response> {
    let path = query.path.ok_or_else(|| {
        (StatusCode::BAD_REQUEST, "缺少 path 参数".to_string()).into_response()
    })?;

    let is_dir = path.ends_with('/');

    let etag = file_ops::create_entry(&state.config.data_dir, &state.pool, &path, is_dir)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e).into_response())?;

    state.broadcaster.send(crate::handler::events::FileEvent::Created {
        path: path.clone(),
        is_dir,
    });

    Ok(Json(serde_json::json!({ "etag": etag })))
}

/// DELETE /api/files - 删除文件或目录
pub async fn delete_entry(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<StatusCode, Response> {
    let path = query.path.ok_or_else(|| {
        (StatusCode::BAD_REQUEST, "缺少 path 参数".to_string()).into_response()
    })?;

    file_ops::delete_entry(&state.config.data_dir, &state.pool, &path)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e).into_response())?;

    state.broadcaster.send(crate::handler::events::FileEvent::Deleted {
        path: path.clone(),
    });

    Ok(StatusCode::NO_CONTENT)
}

/// PATCH /api/files - 重命名/移动
pub async fn rename_entry(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
    Json(body): Json<crate::model::file::RenameRequest>,
) -> Result<Json<serde_json::Value>, Response> {
    let old_path = query.path.ok_or_else(|| {
        (StatusCode::BAD_REQUEST, "缺少 path 参数".to_string()).into_response()
    })?;

    let etag = file_ops::rename_entry(
        &state.config.data_dir,
        &state.pool,
        &old_path,
        &body.new_path,
    )
    .await
    .map_err(|e| (StatusCode::BAD_REQUEST, e).into_response())?;

    state.broadcaster.send(crate::handler::events::FileEvent::Renamed {
        old_path: old_path.clone(),
        new_path: body.new_path.clone(),
    });

    Ok(Json(serde_json::json!({ "etag": etag })))
}

/// GET /api/files/info - 文件详细信息
pub async fn get_file_info(
    State(state): State<AppState>,
    Query(query): Query<PathQuery>,
) -> Result<Json<crate::model::file::FileMeta>, Response> {
    let path = query.path.ok_or_else(|| {
        (StatusCode::BAD_REQUEST, "缺少 path 参数".to_string()).into_response()
    })?;

    let meta = file_ops::get_file_info(&state.config.data_dir, &state.pool, &path)
        .await
        .map_err(|e| (StatusCode::NOT_FOUND, e).into_response())?;

    Ok(Json(meta))
}

/// GET /api/files/search - 文件搜索
pub async fn search_files(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<crate::model::file::FileMeta>>, Response> {
    let pattern = format!("%{}%", query.q);
    let results = sqlx::query_as::<_, crate::model::file::FileMeta>(
        "SELECT * FROM file_meta WHERE path LIKE ? AND is_dir = 0 ORDER BY path",
    )
    .bind(&pattern)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response())?;

    Ok(Json(results))
}

// ---- 辅助函数 ----

async fn extract_multipart_data(mut multipart: Multipart) -> Result<Bytes, Response> {
    let mut data = bytes::BytesMut::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()).into_response())?
    {
        let chunk = field
            .bytes()
            .await
            .map_err(|e| (StatusCode::BAD_REQUEST, e.to_string()).into_response())?;
        data.extend_from_slice(&chunk);
    }
    Ok(data.freeze())
}
