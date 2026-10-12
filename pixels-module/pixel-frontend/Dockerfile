# Multi-stage build for React Vite frontend
FROM node:20-alpine AS build

WORKDIR /app

# Install dependencies
COPY package.json ./
RUN npm install

# Build arguments for backend connection
ARG VITE_BACKEND_HTTP_URL=http://localhost:8000
ARG VITE_BACKEND_WS_URL=ws://localhost:8000/ws/pixels

ENV VITE_BACKEND_HTTP_URL=$VITE_BACKEND_HTTP_URL \
    VITE_BACKEND_WS_URL=$VITE_BACKEND_WS_URL

# Copy source code and build
COPY . .
RUN npm run build

# Production lightweight server
FROM nginx:alpine

COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
