# STUB de NotificationAPI (C#). Se reemplaza por notifications-module/ sin tocar el gateway.
FROM node:22-alpine
WORKDIR /app
COPY server.mjs ./
USER node
EXPOSE 8080
HEALTHCHECK --interval=5s --timeout=3s --retries=10 CMD wget -qO- http://127.0.0.1:8080/health || exit 1
CMD ["node", "server.mjs"]
