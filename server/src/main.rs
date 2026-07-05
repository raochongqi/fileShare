use fileshare_server::config::Config;
use fileshare_server::handler::events::EventBroadcaster;
use fileshare_server::handler::files::AppState;
use fileshare_server::router::build_router;
use fileshare_server::service::{lock_mgr, meta_sync};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 初始化日志
    tracing_subscriber::fmt::init();

    // 加载配置
    let config = Config::load();
    tracing::info!("配置加载完成: 监听 {}", config.listen_addr);

    // 初始化 SQLite
    let pool = fileshare_server::db::sqlite::init_pool(&config.data_dir).await?;
    tracing::info!("SQLite 初始化完成");

    // 启动时元数据同步
    meta_sync::sync(&config.data_dir, &pool).await?;
    tracing::info!("元数据同步完成");

    // 启动后台锁清理任务
    lock_mgr::start_cleanup_task(pool.clone());
    tracing::info!("锁清理任务已启动");

    // 创建事件广播器
    let broadcaster = EventBroadcaster::new();

    // 构建路由
    let state = AppState {
        pool,
        config: config.clone(),
        broadcaster,
    };
    let app = build_router(state);

    // 启动服务
    let listener = tokio::net::TcpListener::bind(&config.listen_addr).await?;
    tracing::info!("服务启动: http://{}", config.listen_addr);
    axum::serve(listener, app).await?;

    Ok(())
}
