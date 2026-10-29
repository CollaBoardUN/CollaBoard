use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

pub const CANVAS_WIDTH: usize = 200;
pub const CANVAS_HEIGHT: usize = 200;
pub const TOTAL_PIXELS: usize = CANVAS_WIDTH * CANVAS_HEIGHT; // 40,000

// Paleta clásica de 16 colores idéntica a la UI del frontend (PaletteToolbar.tsx)
pub const PALETTE: [&str; 16] = [
    "#FFFFFF", // 0: Blanco (lienzo base)
    "#000000", // 1: Negro
    "#4B5563", // 2: Gris Oscuro
    "#9CA3AF", // 3: Gris Claro
    "#EF4444", // 4: Rojo Carmesí
    "#F97316", // 5: Naranja Fuego
    "#F59E0B", // 6: Ámbar Cálido
    "#FBBF24", // 7: Amarillo Sol
    "#84CC16", // 8: Verde Lima
    "#10B981", // 9: Verde Esmeralda
    "#06B6D4", // 10: Turquesa
    "#0EA5E9", // 11: Cian CollaBoard
    "#6366F1", // 12: Índigo CollaBoard
    "#8B5CF6", // 13: Púrpura Real
    "#EC4899", // 14: Rosa Neón
    "#78350F", // 15: Café Roble
];

pub fn hex_to_palette_index(hex: &str) -> u8 {
    let normalized = hex.trim().to_uppercase();
    for (i, &color) in PALETTE.iter().enumerate() {
        if color == normalized {
            return i as u8;
        }
    }
    // Si es un color hexadecimal personalizado, buscamos el color más cercano en RGB
    closest_palette_index(&normalized)
}

fn hex_to_rgb(hex: &str) -> Option<(u8, u8, u8)> {
    let clean = hex.trim().trim_start_matches('#');
    if clean.len() == 6 {
        let r = u8::from_str_radix(&clean[0..2], 16).ok()?;
        let g = u8::from_str_radix(&clean[2..4], 16).ok()?;
        let b = u8::from_str_radix(&clean[4..6], 16).ok()?;
        Some((r, g, b))
    } else if clean.len() == 3 {
        let r = u8::from_str_radix(&clean[0..1].repeat(2), 16).ok()?;
        let g = u8::from_str_radix(&clean[1..2].repeat(2), 16).ok()?;
        let b = u8::from_str_radix(&clean[2..3].repeat(2), 16).ok()?;
        Some((r, g, b))
    } else {
        None
    }
}

fn closest_palette_index(hex: &str) -> u8 {
    let (r1, g1, b1) = match hex_to_rgb(hex) {
        Some(rgb) => rgb,
        None => return 12, // Default Índigo CollaBoard
    };

    let mut min_dist = u32::MAX;
    let mut best_index = 0u8;

    for (i, &color) in PALETTE.iter().enumerate() {
        if let Some((r2, g2, b2)) = hex_to_rgb(color) {
            let dr = (r1 as i32) - (r2 as i32);
            let dg = (g1 as i32) - (g2 as i32);
            let db = (b1 as i32) - (b2 as i32);
            let dist = (dr * dr + dg * dg + db * db) as u32;
            if dist < min_dist {
                min_dist = dist;
                best_index = i as u8;
            }
        }
    }
    best_index
}

pub fn palette_index_to_hex(index: u8) -> &'static str {
    let idx = (index as usize) % PALETTE.len();
    PALETTE[idx]
}

pub struct AtomicCanvas {
    // Buffer plano atómico en memoria continua para máxima velocidad en L1/L2
    buffer: Arc<[AtomicU8]>,
}

impl Default for AtomicCanvas {
    fn default() -> Self {
        Self::new()
    }
}

impl AtomicCanvas {
    pub fn new() -> Self {
        // Inicializa los 40,000 píxeles con 0 (Blanco)
        let buffer: Arc<[AtomicU8]> = (0..TOTAL_PIXELS).map(|_| AtomicU8::new(0)).collect();
        Self { buffer }
    }

    #[inline(always)]
    pub fn coords_to_index(x: usize, y: usize) -> Option<usize> {
        if x < CANVAS_WIDTH && y < CANVAS_HEIGHT {
            Some(y * CANVAS_WIDTH + x)
        } else {
            None
        }
    }

    #[inline(always)]
    pub fn get_pixel_index(&self, x: usize, y: usize) -> Option<u8> {
        let idx = Self::coords_to_index(x, y)?;
        Some(self.buffer[idx].load(Ordering::Relaxed))
    }

    #[inline(always)]
    pub fn set_pixel(&self, x: usize, y: usize, color_index: u8) -> Result<(), &'static str> {
        let idx = match Self::coords_to_index(x, y) {
            Some(i) => i,
            None => return Err("Coordenadas fuera de los límites del lienzo (200x200)"),
        };

        // Escritura atómica lock-free
        self.buffer[idx].store(color_index, Ordering::SeqCst);
        Ok(())
    }

    /// Genera snapshot binario ultra-rápido de 40.000 bytes
    pub fn snapshot_binary(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(TOTAL_PIXELS);
        for pixel in self.buffer.iter() {
            out.push(pixel.load(Ordering::Relaxed));
        }
        out
    }

    /// Carga estado inicial desde bytes
    pub fn load_from_bytes(&self, data: &[u8]) {
        for (i, &byte) in data.iter().take(TOTAL_PIXELS).enumerate() {
            self.buffer[i].store(byte % (PALETTE.len() as u8), Ordering::SeqCst);
        }
    }
}
