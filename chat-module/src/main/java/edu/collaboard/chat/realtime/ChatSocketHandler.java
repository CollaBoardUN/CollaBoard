package edu.collaboard.chat.realtime;

import com.fasterxml.jackson.databind.ObjectMapper;
import edu.collaboard.chat.data.ChatMessage;
import edu.collaboard.chat.data.ChatRead;
import java.time.Instant;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.FindAndModifyOptions;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.dao.DuplicateKeyException;
import edu.collaboard.chat.security.ChatPrincipal;
import edu.collaboard.chat.security.JwtService;
import edu.collaboard.chat.service.BoardPermissions;
import edu.collaboard.chat.service.CollaborationClient.BoardUnavailableException;
import edu.collaboard.chat.service.CollaborationClient.CollaborationUnavailableException;
import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.stereotype.Component;
import org.springframework.web.socket.CloseStatus;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.ConcurrentWebSocketSessionDecorator;
import org.springframework.web.socket.handler.TextWebSocketHandler;

@Component
public class ChatSocketHandler extends TextWebSocketHandler {
    private static final Logger log = LoggerFactory.getLogger(ChatSocketHandler.class);
    private final MongoTemplate mongo;
    private final Map<String, Long> viewing = new ConcurrentHashMap<>();
    private final JwtService jwt;
    private final BoardPermissions permissions;
    private final ObjectMapper json;
    private final Map<String, Connection> connections = new ConcurrentHashMap<>();
    private record Connection(WebSocketSession socket, String boardId, ChatPrincipal user) {}

    public ChatSocketHandler(JwtService jwt, BoardPermissions permissions, ObjectMapper json, MongoTemplate mongo) {
        this.mongo = mongo; this.jwt = jwt; this.permissions = permissions; this.json = json;
    }

    @Override public void afterConnectionEstablished(WebSocketSession session) throws IOException {
        var socket = new ConcurrentWebSocketSessionDecorator(session, 5_000, 64 * 1024);
        try {
            ChatPrincipal user = jwt.authenticate((String) session.getAttributes().get("chatToken"));
            String path = session.getUri().getPath();
            String boardId = path.substring(path.lastIndexOf('/') + 1);
            Connection connection = new Connection(socket, boardId, user);
            if (authorized(connection)) connections.put(session.getId(), connection);
        } catch (JwtException invalid) {
            close(socket, 4401, "No autenticado");
        }
    }

    /** Revalidar antes de CADA entrega: un miembro retirado no recibe el siguiente mensaje. */
    public void broadcast(String boardId, ChatMessage message) {
        for (Connection connection : connections.values()) {
            if (connection.boardId().equals(boardId) && authorized(connection)) {
                send(connection, Map.of("type", "message", "message", message));
            }
        }
    }

    @Scheduled(fixedDelayString = "${collaboard.websocket.recheck-ms:15000}",
            initialDelayString = "${collaboard.websocket.recheck-ms:15000}")
    public void revalidate() {
        connections.values().forEach(this::authorized);
    }

    private boolean authorized(Connection connection) {
        try {
            jwt.authenticate(connection.user().token());
            permissions.requireBoard(connection.user().token(), connection.boardId());
            return true;
        } catch (JwtException invalid) {
            close(connection.socket(), 4401, "Sesión vencida");
        } catch (BoardUnavailableException denied) {
            close(connection.socket(), 4403, "Sin acceso al tablero");
        } catch (CollaborationUnavailableException unavailable) {
            send(connection, Map.of("type", "error", "code", "unavailable", "message", "Colaboración no responde"));
            close(connection.socket(), 1011, "Colaboración no responde");
        } catch (RuntimeException failure) {
            log.warn("No se pudo revalidar WS ({})", failure.getClass().getSimpleName());
            close(connection.socket(), 1011, "No se pudo validar el acceso");
        }
        return false;
    }

    @Override protected void handleTextMessage(WebSocketSession session, TextMessage message) {
        Connection connection = connections.get(session.getId());
        if (connection == null || !authorized(connection)) return;
        try {
            var body = json.readTree(message.getPayload());
            if (body != null && body.isObject() && "ping".equals(body.path("type").asText())) {
                send(connection, Map.of("type", "pong"));
            } else if (body != null && "receipts".equals(body.path("type").asText())) {
                send(connection, Map.of("type", "receipts", "receipts", mongo.find(
                    Query.query(Criteria.where("boardId").is(connection.boardId())), ChatRead.class)));
            } else if (body != null && "view".equals(body.path("type").asText())) {
                if (!body.path("active").asBoolean(false)) { viewing.remove(session.getId()); return; }
                String id = body.path("message_id").asText("");
                if (!id.isBlank()) {
                    ChatMessage anchor = mongo.findById(id, ChatMessage.class);
                    if (anchor == null || !anchor.boardId().equals(connection.boardId())) return;
                    recordRead(connection, anchor);
                }
                viewing.put(session.getId(), System.currentTimeMillis());
            } else {
                send(connection, Map.of("type", "error", "code", "http_only", "message", "Envía mensajes por HTTP"));
            }
        } catch (com.fasterxml.jackson.core.JsonProcessingException invalid) {
            send(connection, Map.of("type", "error", "code", "bad_message", "message", "JSON inválido"));
        }
    }

    public boolean isViewing(String boardId, String userId) {
        long now = System.currentTimeMillis();
        return connections.values().stream().anyMatch(c -> c.boardId().equals(boardId)
            && c.user().id().equals(userId) && c.socket().isOpen()
            && now - viewing.getOrDefault(c.socket().getId(), 0L) < 8_000);
    }

    private void recordRead(Connection c, ChatMessage message) {
        String key = c.boardId() + ":" + c.user().id();
        Criteria newer = new Criteria().orOperator(Criteria.where("messageCreatedAt").lt(message.createdAt()),
            new Criteria().andOperator(Criteria.where("messageCreatedAt").is(message.createdAt()),
                Criteria.where("messageId").lt(message.id())), Criteria.where("messageCreatedAt").exists(false));
        Query query = Query.query(new Criteria().andOperator(Criteria.where("_id").is(key), newer));
        Update update = new Update().set("boardId", c.boardId()).set("userId", c.user().id())
            .set("userName", c.user().name()).set("messageId", message.id())
            .set("messageCreatedAt", message.createdAt()).set("readAt", Instant.now());
        try {
            ChatRead receipt = mongo.findAndModify(query, update,
                FindAndModifyOptions.options().upsert(true).returnNew(true), ChatRead.class);
            for (Connection target : connections.values()) {
                if (target.boardId().equals(c.boardId()) && authorized(target))
                    send(target, Map.of("type", "read", "receipt", receipt));
            }
        } catch (DuplicateKeyException olderOrSame) { /* Monotonic cursor: no repeated or older receipt. */ }
    }

    private void send(Connection connection, Object payload) {
        try {
            if (connection.socket().isOpen()) connection.socket().sendMessage(new TextMessage(json.writeValueAsString(payload)));
        } catch (IOException | RuntimeException failure) {
            log.warn("No se pudo entregar por WS; recuperación disponible por HTTP");
            close(connection.socket(), 1011, "Reconecta para recuperar mensajes");
        }
    }

    private void close(WebSocketSession socket, int code, String reason) {
        connections.remove(socket.getId());
        viewing.remove(socket.getId());
        try { if (socket.isOpen()) socket.close(new CloseStatus(code, reason)); }
        catch (IOException ignored) { /* Ya se retiró de la difusión. */ }
    }

    @Override public void afterConnectionClosed(WebSocketSession session, CloseStatus status) {
        connections.remove(session.getId());
        viewing.remove(session.getId());
    }
    @Override public void handleTransportError(WebSocketSession session, Throwable exception) {
        close(session, 1011, "Error de transporte");
    }
}
