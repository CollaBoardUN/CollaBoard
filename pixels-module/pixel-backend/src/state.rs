use dashmap::DashSet;
use std::collections::VecDeque;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc, RwLock};

use crate::canvas::{palette_index_to_hex, AtomicCanvas, CANVAS_HEIGHT, CANVAS_WIDTH};
use crate::config::AppConfig;
use crate::cooldown::CooldownManager;
use crate::db::MongoPersistence;
use crate::models::{ActivityItem, PixelPoint, PixelRecord, ServerWsMessage};

#[derive(Clone)]
pub struct AppState {
    pub canvas: Arc<AtomicCanvas>,
    pub cooldown: Arc<CooldownManager>,
    pub broadcast_tx: broadcast::Sender<ServerWsMessage>,
    pub persistence_tx: mpsc::Sender<PixelRecord>,
    pub total_placed: Arc<AtomicUsize>,
    pub unique_contributors: Arc<DashSet<String>>,
    pub users_online: Arc<AtomicUsize>,
    pub activities: Arc<RwLock<VecDeque<ActivityItem>>>,
    pub mongo: MongoPersistence,
    pub config: AppConfig,
}

impl AppState {
    pub fn new(
        config: AppConfig,
        mongo: MongoPersistence,
        persistence_tx: mpsc::Sender<PixelRecord>,
    ) -> Self {
        let (broadcast_tx, _) = broadcast::channel(4096);
        Self {
            canvas: Arc::new(AtomicCanvas::new()),
            cooldown: Arc::new(CooldownManager::new(config.cooldown_seconds)),
            broadcast_tx,
            persistence_tx,
            total_placed: Arc::new(AtomicUsize::new(0)),
            unique_contributors: Arc::new(DashSet::new()),
            users_online: Arc::new(AtomicUsize::new(0)),
            activities: Arc::new(RwLock::new(VecDeque::with_capacity(32))),
            mongo,
            config,
        }
    }

    pub async fn apply_pixel(
        &self,
        x: usize,
        y: usize,
        color_hex: &str,
        user_id: &str,
    ) -> Result<PixelPoint, String> {
        // 1. Validar cooldown en memoria
        if let Err(remaining) = self.cooldown.check_and_update(user_id) {
            return Err(format!(
                "Debes esperar {:.1} segundos antes de colocar otro píxel",
                remaining
            ));
        }

        // 2. Resolver índice de paleta y actualizar memoria atómica lock-free
        let p_index = crate::canvas::hex_to_palette_index(color_hex);
        if let Err(err) = self.canvas.set_pixel(x, y, p_index) {
            return Err(err.to_string());
        }

        let canonical_color = palette_index_to_hex(p_index).to_string();
        let timestamp = chrono::Utc::now().to_rfc3339();

        // 3. Incrementar métricas
        self.total_placed.fetch_add(1, Ordering::Relaxed);
        self.unique_contributors.insert(user_id.to_string());

        let pixel_point = PixelPoint {
            x,
            y,
            color: canonical_color.clone(),
        };

        // 4. Agregar a feed de actividad reciente
        let activity = ActivityItem {
            id: format!("{}_{}", chrono::Utc::now().timestamp_millis(), x * 1000 + y),
            x,
            y,
            color: canonical_color.clone(),
            user_id: user_id.to_string(),
            timestamp: timestamp.clone(),
        };
        {
            let mut acts = self.activities.write().await;
            acts.push_front(activity);
            if acts.len() > 15 {
                acts.pop_back();
            }
        }

        // 5. Retransmitir delta en canal broadcast
        let update_msg = ServerWsMessage::PixelUpdated {
            pixels: vec![pixel_point.clone()],
            user_id: user_id.to_string(),
            timestamp: timestamp.clone(),
        };
        let _ = self.broadcast_tx.send(update_msg);

        // 6. Retransmitir estadísticas actualizadas
        let stats_msg = ServerWsMessage::StatsUpdated {
            users_online: self.users_online.load(Ordering::Relaxed),
            total_placed: self.total_placed.load(Ordering::Relaxed),
            unique_contributors: self.unique_contributors.len(),
        };
        let _ = self.broadcast_tx.send(stats_msg);

        // 7. Encolar asíncronamente para persistencia desacoplada en MongoDB
        let record = PixelRecord {
            x,
            y,
            color: canonical_color,
            user_id: user_id.to_string(),
            timestamp,
        };
        let _ = self.persistence_tx.try_send(record);

        Ok(pixel_point)
    }

    pub fn get_placed_pixels(&self) -> Vec<PixelPoint> {
        let mut result = Vec::new();
        for y in 0..CANVAS_HEIGHT {
            for x in 0..CANVAS_WIDTH {
                if let Some(p_idx) = self.canvas.get_pixel_index(x, y) {
                    if p_idx != 0 {
                        // Omitimos píxeles blancos vacíos por defecto para mantener respuesta compacta
                        result.push(PixelPoint {
                            x,
                            y,
                            color: palette_index_to_hex(p_idx).to_string(),
                        });
                    }
                }
            }
        }
        result
    }
}
