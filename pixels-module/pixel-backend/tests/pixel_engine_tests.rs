#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use collaboard_pixel_backend::canvas::{
        hex_to_palette_index, palette_index_to_hex, AtomicCanvas, TOTAL_PIXELS,
    };
    use collaboard_pixel_backend::cooldown::CooldownManager;

    #[test]
    fn test_canvas_initialization() {
        let canvas = AtomicCanvas::new();
        assert_eq!(canvas.snapshot_binary().len(), TOTAL_PIXELS);

        // Todos los píxeles deben ser 0 (Blanco) inicialmente
        for byte in canvas.snapshot_binary() {
            assert_eq!(byte, 0);
        }
    }

    #[test]
    fn test_canvas_pixel_placement_and_bounds() {
        let canvas = AtomicCanvas::new();

        // Color 12 es Índigo (#6366F1)
        assert!(canvas.set_pixel(10, 20, 12).is_ok());
        assert_eq!(canvas.get_pixel_index(10, 20), Some(12));

        // Fuera de límites
        assert!(canvas.set_pixel(200, 200, 12).is_err());
        assert_eq!(canvas.get_pixel_index(200, 200), None);
    }

    #[test]
    fn test_palette_color_mapping() {
        assert_eq!(hex_to_palette_index("#FFFFFF"), 0);
        assert_eq!(hex_to_palette_index("#000000"), 1);
        assert_eq!(hex_to_palette_index("#6366F1"), 12);
        assert_eq!(palette_index_to_hex(12), "#6366F1");
    }

    #[tokio::test]
    async fn test_concurrent_lock_free_canvas_writes() {
        let canvas = Arc::new(AtomicCanvas::new());
        let mut handles = Vec::new();

        // 10 workers escribiendo concurrentemente en 4000 píxeles cada uno
        for worker_id in 0..10 {
            let canvas_clone = Arc::clone(&canvas);
            let handle = tokio::spawn(async move {
                let start_idx = worker_id * 4000;
                let end_idx = start_idx + 4000;
                for idx in start_idx..end_idx {
                    let x = idx % 200;
                    let y = idx / 200;
                    let color = (worker_id % 16) as u8;
                    canvas_clone.set_pixel(x, y, color).unwrap();
                }
            });
            handles.push(handle);
        }

        for handle in handles {
            handle.await.unwrap();
        }

        // Validar que no haya corrupción de memoria
        let snapshot = canvas.snapshot_binary();
        assert_eq!(snapshot.len(), TOTAL_PIXELS);
        for worker_id in 0..10 {
            let sample_idx = worker_id * 4000 + 100;
            let expected_color = (worker_id % 16) as u8;
            assert_eq!(snapshot[sample_idx], expected_color);
        }
    }

    #[test]
    fn test_cooldown_rejection_and_expiration() {
        // Cooldown de 0.1 segundos (100 ms) para la prueba rápida
        let manager = CooldownManager::new(0.1);
        let user = "artista-test-1";

        // Primer intento debe pasar
        assert!(manager.check_and_update(user).is_ok());

        // Segundo intento inmediato debe ser rechazado
        let err = manager.check_and_update(user);
        assert!(err.is_err());
        assert!(err.unwrap_err() > 0.0);

        // Esperar a que expire el cooldown
        std::thread::sleep(std::time::Duration::from_millis(120));

        // Ahora debe volver a pasar
        assert!(manager.check_and_update(user).is_ok());
    }
}
