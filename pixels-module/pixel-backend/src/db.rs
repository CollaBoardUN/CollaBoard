use mongodb::{
    bson::doc,
    options::{ClientOptions, UpdateOptions},
    Client, Database,
};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;
use tracing::{error, info, warn};

use crate::canvas::{AtomicCanvas, hex_to_palette_index};
use crate::models::PixelRecord;

#[derive(Clone)]
pub struct MongoPersistence {
    db: Option<Database>,
    connected: Arc<AtomicBool>,
}

impl MongoPersistence {
    pub async fn new(uri: &str, db_name: &str) -> Self {
        let connected = Arc::new(AtomicBool::new(false));

        let mut client_options = match ClientOptions::parse(uri).await {
            Ok(opts) => opts,
            Err(e) => {
                warn!("No se pudo parsear URI de MongoDB ({}): {}", uri, e);
                return Self {
                    db: None,
                    connected,
                };
            }
        };

        client_options.connect_timeout = Some(Duration::from_secs(3));
        client_options.server_selection_timeout = Some(Duration::from_secs(3));

        match Client::with_options(client_options) {
            Ok(client) => match client.database(db_name).run_command(doc! { "ping": 1 }).await {
                Ok(_) => {
                    info!("Conexión a MongoDB establecida exitosamente en '{}'", db_name);
                    connected.store(true, Ordering::SeqCst);
                    Self {
                        db: Some(client.database(db_name)),
                        connected,
                    }
                }
                Err(e) => {
                    warn!("MongoDB no respondió ping: {}. Operando en modo memoria pura.", e);
                    Self {
                        db: None,
                        connected,
                    }
                }
            },
            Err(e) => {
                warn!("No se pudo inicializar cliente MongoDB: {}", e);
                Self {
                    db: None,
                    connected,
                }
            }
        }
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    pub async fn load_initial_state(&self, canvas: &AtomicCanvas) {
        let db = match &self.db {
            Some(d) => d,
            None => return,
        };

        let collection = db.collection::<mongodb::bson::Document>("pixels");
        let mut cursor = match collection.find(doc! {}).await {
            Ok(c) => c,
            Err(e) => {
                warn!("Error leyendo píxeles iniciales de MongoDB: {}", e);
                return;
            }
        };

        let mut count = 0;
        use futures_util::stream::StreamExt;
        while let Some(result) = cursor.next().await {
            if let Ok(doc) = result {
                if let (Some(x), Some(y), Some(color)) = (
                    doc.get_i64("x").ok().or_else(|| doc.get_i32("x").ok().map(|v| v as i64)),
                    doc.get_i64("y").ok().or_else(|| doc.get_i32("y").ok().map(|v| v as i64)),
                    doc.get_str("color").ok(),
                ) {
                    let p_idx = hex_to_palette_index(color);
                    if canvas.set_pixel(x as usize, y as usize, p_idx).is_ok() {
                        count += 1;
                    }
                }
            }
        }
        info!("Cargados {} píxeles persistidos desde MongoDB", count);
    }

    /// Lanza el worker en background para debouncing y batch flush
    pub fn start_batch_worker(
        self,
        mut rx: mpsc::Receiver<PixelRecord>,
    ) -> tokio::task::JoinHandle<()> {
        tokio::spawn(async move {
            let mut batch = Vec::with_capacity(128);
            let flush_interval = Duration::from_millis(2000);
            let mut interval = tokio::time::interval(flush_interval);

            loop {
                tokio::select! {
                    Some(record) = rx.recv() => {
                        batch.push(record);
                        if batch.len() >= 100 {
                            Self::flush_batch(&self.db, &mut batch).await;
                        }
                    }
                    _ = interval.tick() => {
                        if !batch.is_empty() {
                            Self::flush_batch(&self.db, &mut batch).await;
                        }
                    }
                    else => break,
                }
            }

            if !batch.is_empty() {
                Self::flush_batch(&self.db, &mut batch).await;
            }
        })
    }

    async fn flush_batch(db_opt: &Option<Database>, batch: &mut Vec<PixelRecord>) {
        if batch.is_empty() {
            return;
        }

        let db = match db_opt {
            Some(d) => d,
            None => {
                batch.clear();
                return;
            }
        };

        let collection = db.collection::<mongodb::bson::Document>("pixels");
        let update_options = UpdateOptions::builder().upsert(true).build();

        for record in batch.drain(..) {
            let filter = doc! { "x": record.x as i64, "y": record.y as i64 };
            let update = doc! {
                "$set": {
                    "color": &record.color,
                    "author": &record.user_id,
                    "updatedAt": &record.timestamp,
                }
            };

            if let Err(e) = collection
                .update_one(filter, update)
                .with_options(update_options.clone())
                .await
            {
                error!("Error guardando píxel ({}, {}) en MongoDB: {}", record.x, record.y, e);
            }
        }
    }
}
