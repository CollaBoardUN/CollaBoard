use axum::{
    extract::{
        ws::{Message, WebSocket},
        State, WebSocketUpgrade,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use std::sync::atomic::Ordering;
use tracing::{debug, info};

use crate::models::{ClientWsMessage, ServerWsMessage};
use crate::state::AppState;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    state.users_online.fetch_add(1, Ordering::Relaxed);
    info!(
        "Nueva conexión WebSocket activa. Usuarios online: {}",
        state.users_online.load(Ordering::Relaxed)
    );

    // Emitir stats iniciales
    let stats_msg = ServerWsMessage::StatsUpdated {
        users_online: state.users_online.load(Ordering::Relaxed),
        total_placed: state.total_placed.load(Ordering::Relaxed),
        unique_contributors: state.unique_contributors.len(),
    };
    let _ = state.broadcast_tx.send(stats_msg);

    let (mut sender, mut receiver) = socket.split();
    let mut rx = state.broadcast_tx.subscribe();

    // Tarea para enviar mensajes del canal broadcast al cliente WebSocket
    let mut send_task = tokio::spawn(async move {
        while let Ok(msg) = rx.recv().await {
            if let Ok(text) = serde_json::to_string(&msg) {
                if sender.send(Message::Text(text)).await.is_err() {
                    break;
                }
            }
        }
    });

    let state_clone = state.clone();
    // Tarea para recibir mensajes del cliente WebSocket
    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(message)) = receiver.next().await {
            match message {
                Message::Text(text) => {
                    if let Ok(client_msg) = serde_json::from_str::<ClientWsMessage>(&text) {
                        match client_msg {
                            ClientWsMessage::PlacePixel {
                                x,
                                y,
                                color,
                                user_id,
                            } => {
                                if let Err(err_msg) =
                                    state_clone.apply_pixel(x, y, &color, &user_id).await
                                {
                                    debug!("Rechazada colocación de píxel: {}", err_msg);
                                }
                            }
                        }
                    }
                }
                Message::Ping(p) => {
                    debug!("Ping recibido: {:?}", p);
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    // Esperar a que termine cualquiera de las tareas
    tokio::select! {
        _ = (&mut send_task) => recv_task.abort(),
        _ = (&mut recv_task) => send_task.abort(),
    };

    state.users_online.fetch_sub(1, Ordering::Relaxed);
    info!(
        "Conexión WebSocket cerrada. Usuarios online: {}",
        state.users_online.load(Ordering::Relaxed)
    );

    // Actualizar stats tras desconexión
    let stats_msg = ServerWsMessage::StatsUpdated {
        users_online: state.users_online.load(Ordering::Relaxed),
        total_placed: state.total_placed.load(Ordering::Relaxed),
        unique_contributors: state.unique_contributors.len(),
    };
    let _ = state.broadcast_tx.send(stats_msg);
}
