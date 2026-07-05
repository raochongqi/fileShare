use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::{IntoResponse, Json, Response},
};
use serde::Deserialize;

use crate::handler::files::AppState;
use crate::handler::events::{EventBroadcaster, FileEvent, LockEventData};
use crate::model::lock::LockRequest;
use crate::service::lock_mgr;

#[derive(Debug, Deserialize)]
pub struct LockQuery {
    pub path: Option<String>,
}

/// POST /api/files/lock - 申请锁
pub async fn acquire_lock(
    State(state): State<AppState>,
    Json(body): Json<LockRequest>,
) -> Result<Json<crate::model::lock::LockAcquireResponse>, Response> {
    // MVP: client_id 和 user 暂时从请求推导，后续从认证中间件获取
    let client_id = "default-client";
    let user = "default-user";

    let result = lock_mgr::acquire(&state.pool, &body, client_id, user)
        .await
        .map_err(|e| (StatusCode::CONFLICT, e).into_response())?;

    // 广播锁变更事件
    broadcast_lock_change(&state.broadcaster, &state.pool, &body.path).await;

    Ok(Json(result))
}

/// PUT /api/files/lock/lease - 续租
pub async fn renew_lock(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(body): Json<LockQuery>,
) -> Result<Json<serde_json::Value>, Response> {
    let lock_token = headers
        .get("X-Lock-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let file_path = body.path.ok_or_else(|| {
        (StatusCode::BAD_REQUEST, "缺少 path 参数".to_string()).into_response()
    })?;

    if lock_token.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "缺少 X-Lock-Token 头".to_string()).into_response());
    }

    let lease_until = lock_mgr::renew(&state.pool, &file_path, &lock_token)
        .await
        .map_err(|e| (StatusCode::CONFLICT, e).into_response())?;

    Ok(Json(serde_json::json!({ "lease_until": lease_until })))
}

/// DELETE /api/files/lock - 释放锁
pub async fn release_lock(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<LockQuery>,
) -> Result<StatusCode, Response> {
    let lock_token = headers
        .get("X-Lock-Token")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let file_path = query.path.ok_or_else(|| {
        (StatusCode::BAD_REQUEST, "缺少 path 参数".to_string()).into_response()
    })?;

    if lock_token.is_empty() {
        return Err((StatusCode::BAD_REQUEST, "缺少 X-Lock-Token 头".to_string()).into_response());
    }

    lock_mgr::release(&state.pool, &file_path, &lock_token)
        .await
        .map_err(|e| (StatusCode::BAD_REQUEST, e).into_response())?;

    // 广播锁变更事件
    broadcast_lock_change(&state.broadcaster, &state.pool, &file_path).await;

    Ok(StatusCode::NO_CONTENT)
}

/// GET /api/files/lock - 查询锁状态
pub async fn query_lock(
    State(state): State<AppState>,
    Query(query): Query<LockQuery>,
) -> Result<Json<Option<crate::model::lock::LockInfo>>, Response> {
    let file_path = query.path.ok_or_else(|| {
        (StatusCode::BAD_REQUEST, "缺少 path 参数".to_string()).into_response()
    })?;

    let lock_info = lock_mgr::query(&state.pool, &file_path)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e).into_response())?;

    Ok(Json(lock_info))
}

/// 广播锁状态变更事件
async fn broadcast_lock_change(broadcaster: &EventBroadcaster, pool: &sqlx::SqlitePool, path: &str) {
    let lock_info = lock_mgr::query(pool, path).await.ok().flatten();
    let lock_data = lock_info.map(|info| LockEventData {
        lock_type: info.lock_type,
        holders: info.holders.iter().map(|h| h.user.clone()).collect(),
        expires_at: chrono::DateTime::from_timestamp_millis(info.lease_until)
            .unwrap_or_default()
            .to_rfc3339(),
    });

    broadcaster.send(FileEvent::LockChanged {
        path: path.to_string(),
        lock: lock_data,
    });
}
