# API Gateway de CollaBoard (Nginx). Sin lógica de negocio: enruta, reenvía
# WebSocket, correlaciona con X-Request-ID y aplica límites básicos.
FROM nginx:1.27-alpine

# openssl solo para crear el certificado de desarrollo si no se monta uno.
RUN apk add --no-cache openssl

# La imagen oficial renderiza /etc/nginx/templates/**/*.template con envsubst
# (solo variables de entorno definidas) hacia /etc/nginx/conf.d/ al arrancar.
COPY nginx.conf /etc/nginx/nginx.conf
COPY snippets/ /etc/nginx/snippets/
COPY templates/ /etc/nginx/templates/
# Corre antes de renderizar las plantillas (los scripts van en orden alfabético).
COPY --chmod=755 gen-dev-cert.sh /docker-entrypoint.d/15-gen-dev-cert.sh
# P3 · S2: convierte GATEWAY_ALLOWED_HOSTS en la regex del map de $host (*.envsh se «sourcea»).
COPY --chmod=755 allowed-hosts.envsh /docker-entrypoint.d/18-allowed-hosts.envsh

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
    CLIENT_MAX_BODY_SIZE=1m \
    TLS_CERT_DIR=/etc/nginx/certs \
    GATEWAY_TLS_PORT=8443 \
    TLS_HSTS_MAX_AGE=300 \
    GATEWAY_ALLOWED_HOSTS=localhost,127.0.0.1,gateway \
    RATE_LIMIT_WEB=20r/s \
    RATE_LIMIT_WEB_BURST=100 \
    LIMIT_CONN_PER_IP=60 \
    LIMIT_CONN_WS_PER_IP=30 \
    CLIENT_MAX_BODY_SIZE_AUTH=16k \
    PIXELS_UI_UPSTREAM=pixels-ui:80

EXPOSE 80 443 8081
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
