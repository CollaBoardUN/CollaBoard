use std::net::SocketAddr;
use std::time::Duration;
use tokio::sync::mpsc;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use collaboard_pixel_backend::config::AppConfig;
use collaboard_pixel_backend::db::MongoPersistence;
use collaboard_pixel_backend::routes::create_router;
use collaboard_pixel_backend::state::AppState;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Configuración de logging y telemetría estructurada
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,collaboard_pixel_backend=debug".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    info!("Iniciando Motor de Pixels CollaBoard (Rust / Tokio / Axum)...");

    let config = AppConfig::from_env();
    info!("Configuración: host={}, port={}, canvas={}x{}, cooldown={}s",
        config.host, config.port, config.canvas_width, config.canvas_height, config.cooldown_seconds
    );

    // Conectar a MongoDB
    let mongo = MongoPersistence::new(&config.mongo_uri, &config.database_name).await;

    // Canal asíncrono para persistencia en segundo plano (buffer de 10.000 operaciones)
    let (persistence_tx, persistence_rx) = mpsc::channel(10_000);

    let state = AppState::new(config.clone(), mongo.clone(), persistence_tx);

    // Cargar píxeles existentes desde MongoDB al inicio
    mongo.load_initial_state(&state.canvas).await;

    // Iniciar worker de batch flush para persistencia desacoplada
    let _worker_handle = mongo.start_batch_worker(persistence_rx);

    // Configuración de CORS permisivo para desarrollo y frontend SPA
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    let app = create_router(state)
        .layer(cors)
        .layer(TraceLayer::new_for_http());

    let addr: SocketAddr = format!("{}:{}", config.host, config.port).parse()?;
    info!("Servicio Pixels escuchando en http://{}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;

    info!("Servicio Pixels detenido limpiamente.");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("Fallo al registrar manejador Ctrl+C");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("Fallo al registrar manejador SIGTERM")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {},
        _ = terminate => {},
    }
    info!("Señal de apagado recibida. Cerrando conexiones...");
    tokio::time::sleep(Duration::from_millis(500)).await;
}
