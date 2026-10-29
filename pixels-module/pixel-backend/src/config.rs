use std::env;

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub mongo_uri: String,
    pub database_name: String,
    pub host: String,
    pub port: u16,
    pub canvas_width: usize,
    pub canvas_height: usize,
    pub cooldown_seconds: f64,
}

impl AppConfig {
    pub fn from_env() -> Self {
        let mongo_uri = env::var("PIXELS_MONGO_URI")
            .or_else(|_| env::var("MONGODB_URL"))
            .unwrap_or_else(|_| "mongodb://pixels-nosql-db:27017".to_string());

        let database_name = env::var("DATABASE_NAME")
            .unwrap_or_else(|_| "collaboard_pixels".to_string());

        let host = env::var("HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
        let port = env::var("PORT")
            .ok()
            .and_then(|p| p.parse().ok())
            .unwrap_or(8000);

        let canvas_width = env::var("CANVAS_WIDTH")
            .ok()
            .and_then(|w| w.parse().ok())
            .unwrap_or(200);

        let canvas_height = env::var("CANVAS_HEIGHT")
            .ok()
            .and_then(|h| h.parse().ok())
            .unwrap_or(200);

        let cooldown_seconds = env::var("COOLDOWN_SECONDS")
            .ok()
            .and_then(|c| c.parse().ok())
            .unwrap_or(5.0);

        Self {
            mongo_uri,
            database_name,
            host,
            port,
            canvas_width,
            canvas_height,
            cooldown_seconds,
        }
    }
}
