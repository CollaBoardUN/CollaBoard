# --- Etapa 1: compilar ---
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Las variables VITE_* se fijan al compilar.
ARG VITE_API_URL=http://localhost:8000
ARG VITE_DEV_LOGIN=true
ENV VITE_API_URL=$VITE_API_URL VITE_DEV_LOGIN=$VITE_DEV_LOGIN
RUN npm run build

# --- Etapa 2: servir archivos estáticos ---
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
