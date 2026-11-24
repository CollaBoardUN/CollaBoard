# Reverse Proxy de CollaBoard (Nginx).
# Responsabilidad: borde público, terminación TLS (S1), validación de Host,
# saneado de cabeceras, límites por IP, cabeceras de seguridad (S2),
# entrega de rutas web/estáticos (web-ssr y pixels-ui) y reenvío de /api/* y /ws/* al API Gateway.
FROM nginx:1.27-alpine

RUN apk add --no-cache openssl

COPY nginx.conf /etc/nginx/nginx.conf
COPY snippets/ /etc/nginx/snippets/
COPY templates/ /etc/nginx/templates/
COPY --chmod=755 gen-dev-cert.sh /docker-entrypoint.d/15-gen-dev-cert.sh
COPY --chmod=755 allowed-hosts.envsh /docker-entrypoint.d/18-allowed-hosts.envsh

ENV NGINX_RESOLVER=127.0.0.11 \
    API_GATEWAY_UPSTREAM=gateway:80 \
    WEB_SSR_UPSTREAM=web-ssr:3000 \
    PIXELS_UI_UPSTREAM=pixels-ui:80 \
    PIZARRA_WS_TOKEN_QUERY=on \
    RATE_LIMIT_API=30r/s \
    RATE_LIMIT_API_BURST=60 \
    RATE_LIMIT_AUTH=5r/s \
    RATE_LIMIT_AUTH_BURST=10 \
    CLIENT_MAX_BODY_SIZE=1m \
    CLIENT_MAX_BODY_SIZE_AUTH=16k \
    TLS_CERT_DIR=/etc/nginx/certs \
    GATEWAY_TLS_PORT=8443 \
    TLS_HSTS_MAX_AGE=300 \
    GATEWAY_ALLOWED_HOSTS=localhost,127.0.0.1,gateway \
    RATE_LIMIT_WEB=20r/s \
    RATE_LIMIT_WEB_BURST=100 \
    LIMIT_CONN_PER_IP=60 \
    LIMIT_CONN_WS_PER_IP=30

EXPOSE 80 443
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=10 \
  CMD wget -qO- http://127.0.0.1/healthz || exit 1
