use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct PixelPoint {
    pub x: usize,
    pub y: usize,
    pub color: String,
}

#[derive(Clone, Debug, Deserialize)]
pub struct PlacePixelRequest {
    pub x: usize,
    pub y: usize,
    pub color: String,
    #[serde(alias = "userId", alias = "user_id")]
    pub user_id: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct PlacePixelResponse {
    pub success: bool,
    pub pixel: PixelPoint,
    pub cooldown: f64,
}

#[derive(Clone, Debug, Serialize)]
pub struct BoardStateResponse {
    pub width: usize,
    pub height: usize,
    pub pixels: Vec<PixelPoint>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ActivityItem {
    pub id: String,
    pub x: usize,
    pub y: usize,
    pub color: String,
    #[serde(rename = "userId")]
    pub user_id: String,
    pub timestamp: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct StatsResponse {
    #[serde(rename = "totalPlaced")]
    pub total_placed: usize,
    #[serde(rename = "uniqueContributors")]
    pub unique_contributors: usize,
    #[serde(rename = "canvasWidth")]
    pub canvas_width: usize,
    #[serde(rename = "canvasHeight")]
    pub canvas_height: usize,
    #[serde(rename = "usersOnline")]
    pub users_online: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct HealthResponse {
    pub status: &'static str,
    pub service: &'static str,
    pub engine: &'static str,
    #[serde(rename = "databaseConnected")]
    pub database_connected: bool,
    #[serde(rename = "onlineUsers")]
    pub online_users: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(tag = "type")]
pub enum ClientWsMessage {
    #[serde(rename = "PLACE_PIXEL")]
    PlacePixel {
        x: usize,
        y: usize,
        color: String,
        #[serde(alias = "userId", alias = "user_id")]
        user_id: String,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type")]
pub enum ServerWsMessage {
    #[serde(rename = "PIXEL_UPDATED")]
    PixelUpdated {
        pixels: Vec<PixelPoint>,
        #[serde(rename = "userId")]
        user_id: String,
        timestamp: String,
    },
    #[serde(rename = "STATS_UPDATED")]
    StatsUpdated {
        #[serde(rename = "usersOnline")]
        users_online: usize,
        #[serde(rename = "totalPlaced")]
        total_placed: usize,
        #[serde(rename = "uniqueContributors")]
        unique_contributors: usize,
    },
    #[serde(rename = "COOLDOWN_ACTIVE")]
    CooldownActive {
        remaining: f64,
        message: String,
    },
    #[serde(rename = "ERROR")]
    Error {
        message: String,
    },
}

/// Registro enviado al canal de persistencia en background
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PixelRecord {
    pub x: usize,
    pub y: usize,
    pub color: String,
    pub user_id: String,
    pub timestamp: String,
}
