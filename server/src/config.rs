use std::env;

/// 服务端配置，从 .env 文件或环境变量加载
#[derive(Debug, Clone)]
pub struct Config {
    pub listen_addr: String,
    pub data_dir: String,
    pub auth_token: String,
}

impl Config {
    pub fn load() -> Self {
        // 加载 .env 文件（如果存在），不覆盖已有环境变量
        let _ = dotenvy::dotenv();

        Self {
            listen_addr: env_or("LISTEN_ADDR", "0.0.0.0:8080"),
            data_dir: env_or("DATA_DIR", "./data"),
            auth_token: env_or("AUTH_TOKEN", "change-me"),
        }
    }
}

fn env_or(key: &str, default: &str) -> String {
    env::var(key).unwrap_or_else(|_| default.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config() {
        // 清除可能存在的环境变量，确保使用默认值
        unsafe {
            env::remove_var("LISTEN_ADDR");
            env::remove_var("DATA_DIR");
            env::remove_var("AUTH_TOKEN");
        }

        let config = Config::load();
        assert_eq!(config.listen_addr, "0.0.0.0:8080");
        assert_eq!(config.data_dir, "./data");
        assert_eq!(config.auth_token, "change-me");
    }

    #[test]
    fn test_env_or_returns_env_value() {
        unsafe { env::set_var("TEST_KEY_123", "custom-value"); }
        assert_eq!(env_or("TEST_KEY_123", "default"), "custom-value");
        unsafe { env::remove_var("TEST_KEY_123"); }
    }

    #[test]
    fn test_env_or_returns_default_when_missing() {
        unsafe { env::remove_var("NONEXISTENT_KEY_XYZ"); }
        assert_eq!(env_or("NONEXISTENT_KEY_XYZ", "fallback"), "fallback");
    }

    #[test]
    fn test_config_from_env() {
        // 使用唯一键名避免与并行测试中的其他 env 测试冲突
        unsafe {
            env::set_var("FILESHARE_TEST_LISTEN_ADDR", "127.0.0.1:3000");
            env::set_var("FILESHARE_TEST_DATA_DIR", "/tmp/test-data");
            env::set_var("FILESHARE_TEST_AUTH_TOKEN", "secret-123");
        }

        assert_eq!(env_or("FILESHARE_TEST_LISTEN_ADDR", "default"), "127.0.0.1:3000");
        assert_eq!(env_or("FILESHARE_TEST_DATA_DIR", "default"), "/tmp/test-data");
        assert_eq!(env_or("FILESHARE_TEST_AUTH_TOKEN", "default"), "secret-123");

        unsafe {
            env::remove_var("FILESHARE_TEST_LISTEN_ADDR");
            env::remove_var("FILESHARE_TEST_DATA_DIR");
            env::remove_var("FILESHARE_TEST_AUTH_TOKEN");
        }
    }
}
