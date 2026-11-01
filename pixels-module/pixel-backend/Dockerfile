# ==============================================================================
# Dockerfile Multi-Stage para el Motor de Pixels CollaBoard (Rust / Axum)
# ==============================================================================

# Etapa 1: Compilación del binario estático optimizado
FROM rust:alpine3.20 AS builder

RUN apk add --no-cache musl-dev gcc

WORKDIR /app

# Copiar manifiesto de dependencias para aprovechar la caché de capas de Docker
COPY Cargo.toml ./

RUN mkdir src && echo "fn main() {}" > src/main.rs
RUN cargo build --release && rm -rf src

# Copiar el código fuente completo
COPY src ./src

# Compilar release final y reducir tamaño del binario
RUN touch src/main.rs && \
    cargo build --release && \
    strip target/release/collaboard-pixel-backend

# Etapa 2: Imagen mínima de ejecución en producción
FROM alpine:3.20

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

COPY --from=builder /app/target/release/collaboard-pixel-backend /app/pixel-backend

ENV HOST=0.0.0.0 \
    PORT=8000 \
    RUST_LOG=info

EXPOSE 8000

# Usuario sin privilegios por seguridad
USER 1000:1000

CMD ["/app/pixel-backend"]
