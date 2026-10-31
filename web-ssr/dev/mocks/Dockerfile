# Mocks de desarrollo (Chat + Notificaciones). Solo para el entorno de desarrollo de la web.
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY server.mjs main.mjs ./
USER node
EXPOSE 4100
HEALTHCHECK --interval=5s --timeout=3s --retries=10 CMD wget -qO- http://127.0.0.1:4100/health || exit 1
CMD ["node", "main.mjs"]
