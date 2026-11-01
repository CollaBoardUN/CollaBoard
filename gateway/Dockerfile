# API Gateway de CollaBoard (Nginx). Sin lógica de negocio: enruta, reenvía
# WebSocket, correlaciona con X-Request-ID y aplica límites básicos.
FROM nginx:1.27-alpine

# La imagen oficial renderiza /etc/nginx/templates/**/*.template con envsubst
# (solo variables de entorno definidas) hacia /etc/nginx/conf.d/ al arrancar.
COPY nginx.conf /etc/nginx/nginx.conf
COPY snippets/ /etc/nginx/snippets/
COPY templates/ /etc/nginx/templates/

# Valores por defecto; docker-compose y .env los sobrescriben.
ENV GATEWAY_INTERNAL_PORT=8081 \
    NGINX_RESOLVER=127.0.0.11 \
    WEB_SSR_UPSTREAM=web-ssr:3000 \
    AUTH_API_UPSTREAM=auth-api:8001 \
    AUTH_API_PATH_PREFIX=/auth \
    COLLABORATION_API_UPSTREAM=collaboration-api:8000 \
    COLLABORATION_BOARDS_PATH=/boards \
    COLLABORATION_INVITES_PATH=/invites \
    PIZARRA_API_UPSTREAM=pizarra-api:8000 \
    PIZARRA_BOARDS_PATH=/boards \
    PIZARRA_WS_PATH=/ws/boards \
    PIZARRA_WS_TOKEN_QUERY=on \
    CHAT_API_UPSTREAM=chat-api:8090 \
    PIXELS_API_UPSTREAM=pixels-api:8000 \
    NOTIFICATION_API_UPSTREAM=notification-api:8080 \
    NOTIFICATION_API_PATH_PREFIX=/api/notifications \
    RATE_LIMIT_API=30r/s \
    RATE_LIMIT_API_BURST=60 \
    RATE_LIMIT_AUTH=5r/s \
    RATE_LIMIT_AUTH_BURST=10 \
    CLIENT_MAX_BODY_SIZE=1m

EXPOSE 80 8081
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
