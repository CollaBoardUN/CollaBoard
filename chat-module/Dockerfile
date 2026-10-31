FROM maven:3.9.11-eclipse-temurin-21 AS build
WORKDIR /workspace
COPY pom.xml .
COPY src ./src
RUN mvn -B -DskipTests package

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY --from=build /workspace/target/chat-api-0.1.0.jar /app/chat-api.jar
RUN addgroup -S chat && adduser -S -G chat chat
USER chat
EXPOSE 8090
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=10 \
  CMD wget -qO /dev/null "http://127.0.0.1:${PORT:-8090}/health" || exit 1
ENTRYPOINT ["java", "-jar", "/app/chat-api.jar"]
