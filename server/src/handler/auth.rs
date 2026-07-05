use axum::{
    body::Body,
    http::{Request, StatusCode},
    middleware::Next,
    response::Response,
};

/// Bearer Token 认证中间件
/// 从请求头 Authorization: Bearer <token> 中提取 token 并与配置的 auth_token 比对
pub async fn auth_middleware(
    State(config): State<crate::config::Config>,
    req: Request<Body>,
    next: Next,
) -> Result<Response, StatusCode> {
    // SSE 端点允许无认证连接（后续可通过 query 参数验证）
    let path = req.uri().path();
    if path == "/api/events" {
        return Ok(next.run(req).await);
    }

    // 跳过非 API 路径（如果有静态文件等）
    if !path.starts_with("/api/") {
        return Ok(next.run(req).await);
    }

    // 提取 Authorization 头
    let auth_header = req
        .headers()
        .get("Authorization")
        .and_then(|v| v.to_str().ok());

    match auth_header {
        Some(header) if header.starts_with("Bearer ") => {
            let token = &header[7..];
            if token == config.auth_token {
                Ok(next.run(req).await)
            } else {
                tracing::warn!("认证失败: token 不匹配");
                Err(StatusCode::UNAUTHORIZED)
            }
        }
        _ => {
            tracing::warn!("认证失败: 缺少 Authorization 头");
            Err(StatusCode::UNAUTHORIZED)
        }
    }
}

use axum::extract::State;

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        body::Body,
        http::{Request, StatusCode},
        middleware,
        routing::get,
        Router,
    };
    use tower::ServiceExt;

    async fn fake_handler() -> &'static str {
        "ok"
    }

    fn make_app(auth_token: &str) -> Router {
        let config = crate::config::Config {
            listen_addr: String::new(),
            data_dir: String::new(),
            auth_token: auth_token.to_string(),
        };

        Router::new()
            .route("/api/test", get(fake_handler))
            .route("/api/events", get(fake_handler))
            .layer(middleware::from_fn_with_state(config, auth_middleware))
    }

    #[tokio::test]
    async fn test_auth_valid_token() {
        let app = make_app("secret123");
        let req = Request::builder()
            .uri("/api/test")
            .header("Authorization", "Bearer secret123")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_auth_invalid_token() {
        let app = make_app("secret123");
        let req = Request::builder()
            .uri("/api/test")
            .header("Authorization", "Bearer wrong-token")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_auth_missing_header() {
        let app = make_app("secret123");
        let req = Request::builder()
            .uri("/api/test")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_auth_wrong_scheme() {
        let app = make_app("secret123");
        let req = Request::builder()
            .uri("/api/test")
            .header("Authorization", "Basic secret123")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_auth_sse_skipped() {
        let app = make_app("secret123");
        // SSE 端点无需认证
        let req = Request::builder()
            .uri("/api/events")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_auth_non_api_skipped() {
        let app = make_app("secret123");
        // 非 API 路径跳过认证，但路由不存在则返回 404
        let req = Request::builder()
            .uri("/health")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        // 404 = 认证通过但路由不存在（不是 401）
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_auth_empty_token() {
        let app = make_app("secret123");
        let req = Request::builder()
            .uri("/api/test")
            .header("Authorization", "Bearer ")
            .body(Body::empty())
            .unwrap();
        let resp = app.oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
    }
}
