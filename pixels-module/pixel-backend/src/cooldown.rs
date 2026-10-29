use dashmap::DashMap;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct CooldownManager {
    // user_id -> timestamp en milisegundos de la última colocación
    last_placed: DashMap<String, u64>,
    cooldown_millis: u64,
}

impl CooldownManager {
    pub fn new(cooldown_seconds: f64) -> Self {
        let cooldown_millis = (cooldown_seconds * 1000.0) as u64;
        Self {
            last_placed: DashMap::new(),
            cooldown_millis,
        }
    }

    fn now_millis() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }

    /// Comprueba si el usuario puede colocar un píxel.
    /// Si está permitido, actualiza la marca temporal atómicamente y retorna Ok(()).
    /// Si aún está en cooldown, retorna Err(segundos_restantes).
    pub fn check_and_update(&self, user_id: &str) -> Result<(), f64> {
        let now = Self::now_millis();

        let mut entry = self.last_placed.entry(user_id.to_string()).or_insert(0);
        let last_time = *entry.value();

        if now >= last_time + self.cooldown_millis {
            *entry.value_mut() = now;
            Ok(())
        } else {
            let elapsed = now.saturating_sub(last_time);
            let remaining_millis = self.cooldown_millis.saturating_sub(elapsed);
            let remaining_seconds = (remaining_millis as f64) / 1000.0;
            Err(remaining_seconds)
        }
    }

    /// Consulta el tiempo restante sin actualizar
    pub fn get_remaining(&self, user_id: &str) -> f64 {
        let now = Self::now_millis();
        if let Some(entry) = self.last_placed.get(user_id) {
            let last_time = *entry.value();
            if now < last_time + self.cooldown_millis {
                let elapsed = now.saturating_sub(last_time);
                let remaining_millis = self.cooldown_millis.saturating_sub(elapsed);
                return (remaining_millis as f64) / 1000.0;
            }
        }
        0.0
    }
}
