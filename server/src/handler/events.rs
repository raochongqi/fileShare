use axum::response::sse::{Event, KeepAlive, Sse};
use futures::stream::Stream;
use serde::Serialize;
use std::convert::Infallible;
use tokio::sync::broadcast;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

/// SSE 事件类型
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type")]
pub enum FileEvent {
    /// 文件/目录创建
    #[serde(rename = "created")]
    Created { path: String, is_dir: bool },
    /// 文件内容更新
    #[serde(rename = "updated")]
    Updated { path: String, etag: String },
    /// 文件/目录删除
    #[serde(rename = "deleted")]
    Deleted { path: String },
    /// 文件重命名/移动
    #[serde(rename = "renamed")]
    Renamed { old_path: String, new_path: String },
    /// 锁状态变更
    #[serde(rename = "lock_changed")]
    LockChanged { path: String, lock: Option<LockEventData> },
}

/// 锁事件数据
#[derive(Debug, Clone, Serialize)]
pub struct LockEventData {
    pub lock_type: String,
    pub holders: Vec<String>,
    pub expires_at: String,
}

/// 事件广播器，在整个应用中共享
#[derive(Clone)]
pub struct EventBroadcaster {
    tx: broadcast::Sender<FileEvent>,
}

impl EventBroadcaster {
    pub fn new() -> Self {
        let (tx, _) = broadcast::channel(256);
        Self { tx }
    }

    /// 广播事件
    pub fn send(&self, event: FileEvent) {
        // 忽略发送失败（无接收者）
        let _ = self.tx.send(event);
    }

    /// 创建 SSE 事件流（'static 生命周期，独立于 broadcaster）
    pub fn subscribe(&self) -> impl Stream<Item = Result<Event, Infallible>> + 'static {
        let rx = self.tx.subscribe();
        BroadcastStream::new(rx).map(|msg| {
            match msg {
                Ok(event) => {
                    let data = serde_json::to_string(&event).unwrap_or_default();
                    Ok(Event::default().data(data).event(match &event {
                        FileEvent::Created { .. } => "created",
                        FileEvent::Updated { .. } => "updated",
                        FileEvent::Deleted { .. } => "deleted",
                        FileEvent::Renamed { .. } => "renamed",
                        FileEvent::LockChanged { .. } => "lock_changed",
                    }))
                }
                Err(_) => {
                    // Lagged 消息，忽略
                    Ok(Event::default().comment("heartbeat"))
                }
            }
        })
    }
}

/// GET /api/events - SSE 事件流
pub async fn sse_events(
    State(state): State<crate::handler::files::AppState>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let stream = state.broadcaster.subscribe();
    Sse::new(stream).keep_alive(KeepAlive::default())
}

use axum::extract::State;
