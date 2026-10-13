FROM golang:1.23-alpine AS build
WORKDIR /src
RUN apk add --no-cache ca-certificates git
COPY go.mod ./
# Las dependencias se descargan en la compilación. Ejecuta `go mod tidy` en local
# y versiona go.sum para builds reproducibles cuando tengas Internet.
COPY . .
RUN go mod download && CGO_ENABLED=0 GOOS=linux go build -mod=mod -trimpath -ldflags="-s -w" -o /out/auth-service ./cmd/server

FROM alpine:3.21
RUN apk add --no-cache ca-certificates && addgroup -S app && adduser -S -G app app
WORKDIR /app
COPY --from=build /out/auth-service /app/auth-service
USER app
EXPOSE 8001
CMD ["/app/auth-service"]
