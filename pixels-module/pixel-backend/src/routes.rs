use axum::{
    extract::{Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Json, Response},
    routing::{get, post},
    Router,
};
use serde::Deserialize;
use std::sync::atomic::Ordering;

use crate::canvas::{CANVAS_HEIGHT, CANVAS_WIDTH};
use crate::models::{
    ActivityItem, BoardStateResponse, HealthResponse, PlacePixelRequest, PlacePixelResponse,
    StatsResponse,
};
use crate::state::AppState;
use crate::ws::ws_handler;

#[derive(Deserialize)]
pub struct CanvasQuery {
    pub format: Option<String>,
}

pub fn create_router(state: AppState) -> Router {
    Router::new()
        // Endpoints de salud
        .route("/health", get(health_check))
        .route("/api/health", get(health_check))
        // Endpoints REST de Pixels
        .route("/api/pixels/canvas", get(get_canvas))
        .route("/api/pixels/board", get(get_board))
        .route("/api/pixels/place", post(place_pixel))
        .route("/api/pixels/stats", get(get_stats))
        .route("/api/pixels/activity", get(get_activity))
        // Canal WebSocket en tiempo real
        .route("/ws/pixels", get(ws_handler))
        .with_state(state)
}

async fn health_check(State(state): State<AppState>) -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "healthy",
        service: "pixel-backend",
        engine: "rust-axum-atomic",
        database_connected: state.mongo.is_connected(),
        online_users: state.users_online.load(Ordering::Relaxed),
    })
}

/// GET /api/pixels/canvas: Entrega el snapshot binario o JSON del canvas
async fn get_canvas(
    headers: HeaderMap,
    Query(query): Query<CanvasQuery>,
    State(state): State<AppState>,
) -> Response {
    let wants_binary = query.format.as_deref() == Some("binary")
        || headers
            .get(header::ACCEPT)
            .and_then(|h| h.to_str().ok())
            .map(|s| s.contains("application/octet-stream"))
            .unwrap_or(false);

    if wants_binary {
        let binary_bytes = state.canvas.snapshot_binary();
        (
            StatusCode::OK,
            [(header::CONTENT_TYPE, "application/octet-stream")],
            binary_bytes,
        )
            .into_response()
    } else {
        let pixels = state.get_placed_pixels();
        Json(BoardStateResponse {
            width: CANVAS_WIDTH,
            height: CANVAS_HEIGHT,
            pixels,
        })
        .into_response()
    }
}

/// GET /api/pixels/board: Compatible con el frontend React
async fn get_board(State(state): State<AppState>) -> Json<BoardStateResponse> {
    let pixels = state.get_placed_pixels();
    Json(BoardStateResponse {
        width: CANVAS_WIDTH,
        height: CANVAS_HEIGHT,
        pixels,
    })
}

/// POST /api/pixels/place: Colocación de píxel con validación de cooldown y actualización atómica
async fn place_pixel(
    State(state): State<AppState>,
    Json(payload): Json<PlacePixelRequest>,
) -> Response {
    if payload.x >= CANVAS_WIDTH || payload.y >= CANVAS_HEIGHT {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({
                "type": "ERROR",
                "message": "Coordenadas fuera de rango (deben estar entre 0 y 199)"
            })),
        )
            .into_response();
    }

    match state
        .apply_pixel(payload.x, payload.y, &payload.color, &payload.user_id)
        .await
    {
        Ok(pixel_point) => (
            StatusCode::OK,
            Json(PlacePixelResponse {
                success: true,
                pixel: pixel_point,
                cooldown: state.config.cooldown_seconds,
            }),
        )
            .into_response(),
        Err(err_msg) => {
            let remaining = state.cooldown.get_remaining(&payload.user_id);
            if remaining > 0.0 {
                (
                    StatusCode::TOO_MANY_REQUESTS,
                    Json(serde_json::json!({
                        "type": "COOLDOWN_ACTIVE",
                        "remaining": remaining,
                        "message": err_msg
                    })),
                )
                    .into_response()
            } else {
                (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({
                        "type": "ERROR",
                        "message": err_msg
                    })),
                )
                    .into_response()
            }
        }
    }
}

/// GET /api/pixels/stats: Estadísticas agregadas del lienzo
async fn get_stats(State(state): State<AppState>) -> Json<StatsResponse> {
    Json(StatsResponse {
        total_placed: state.total_placed.load(Ordering::Relaxed),
        unique_contributors: state.unique_contributors.len(),
        canvas_width: CANVAS_WIDTH,
        canvas_height: CANVAS_HEIGHT,
        users_online: state.users_online.load(Ordering::Relaxed),
    })
}

/// GET /api/pixels/activity: Feed de actividad reciente
async fn get_activity(State(state): State<AppState>) -> Json<Vec<ActivityItem>> {
    let acts = state.activities.read().await;
    let list: Vec<ActivityItem> = acts.iter().cloned().collect();
    Json(list)
}
