package edu.collaboard.chat.service;

import com.fasterxml.jackson.databind.JsonNode;
import edu.collaboard.chat.data.ChatMessage;
import edu.collaboard.chat.data.ChatMessageRepository;
import edu.collaboard.chat.realtime.ChatSocketHandler;
import edu.collaboard.chat.security.ChatPrincipal;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.data.domain.Sort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.stereotype.Service;

@Service
public class ChatService {
    private static final Pattern CLIENT_ID = Pattern.compile("[A-Za-z0-9-]{8,64}");
    private static final Pattern EDGE_SPACE = Pattern.compile("^[\\s\\p{Z}\\uFEFF]+|[\\s\\p{Z}\\uFEFF]+$");
    private final ChatMessageRepository messages;
    private final MongoTemplate mongo;
    private final BoardPermissions collaboration;
    private final ChatSocketHandler sockets;

    public ChatService(ChatMessageRepository messages, MongoTemplate mongo,
                       BoardPermissions collaboration, ChatSocketHandler sockets) {
        this.messages = messages;
        this.mongo = mongo;
        this.collaboration = collaboration;
        this.sockets = sockets;
    }

    public ChatPage history(String boardId, ChatPrincipal user, int limit, String before, String after) {
        if (limit < 1 || limit > 100) throw new InvalidChatRequestException("limit debe estar entre 1 y 100");
        collaboration.requireBoard(user.token(), boardId);
        if (before != null && after != null) throw new InvalidChatRequestException("Usa before o after, no ambos");

        Query query = new Query(Criteria.where("boardId").is(boardId));
        boolean hasMore = false;
        if (before != null && !before.isBlank()) {
            Cursor cursor = decodeCursor(before);
            query.addCriteria(new Criteria().orOperator(
                    Criteria.where("createdAt").lt(cursor.at),
                    new Criteria().andOperator(Criteria.where("createdAt").is(cursor.at), Criteria.where("id").lt(cursor.id))));
            query.with(Sort.by(Sort.Direction.DESC, "createdAt", "id")).limit(limit + 1);
            List<ChatMessage> found = mongo.find(query, ChatMessage.class);
            hasMore = found.size() > limit;
            if (hasMore) found.remove(found.size() - 1);
            java.util.Collections.reverse(found);
            return new ChatPage(found, hasMore && !found.isEmpty() ? encodeCursor(found.getFirst()) : null);
        }

        if (after != null && !after.isBlank()) {
            ChatMessage anchor = messages.findById(after).filter(m -> m.boardId().equals(boardId))
                    .orElseThrow(() -> new InvalidChatRequestException("Cursor de mensaje inválido"));
            query.addCriteria(new Criteria().orOperator(
                    Criteria.where("createdAt").gt(anchor.createdAt()),
                    new Criteria().andOperator(Criteria.where("createdAt").is(anchor.createdAt()), Criteria.where("id").gt(anchor.id()))));
            query.with(Sort.by(Sort.Direction.ASC, "createdAt", "id")).limit(limit);
            return new ChatPage(mongo.find(query, ChatMessage.class), null);
        }

        query.with(Sort.by(Sort.Direction.DESC, "createdAt", "id")).limit(limit + 1);
        List<ChatMessage> found = mongo.find(query, ChatMessage.class);
        hasMore = found.size() > limit;
        if (hasMore) found.remove(found.size() - 1);
        java.util.Collections.reverse(found);
        return new ChatPage(found, hasMore && !found.isEmpty() ? encodeCursor(found.getFirst()) : null);
    }

    public SendResult send(String boardId, ChatPrincipal user, String rawText, String clientMessageId) {
        String text = rawText == null ? "" : EDGE_SPACE.matcher(rawText).replaceAll("");
        if (text.isEmpty() || text.length() > 2000) {
            throw new InvalidChatRequestException("El mensaje debe tener entre 1 y 2000 caracteres");
        }
        if (clientMessageId == null || !CLIENT_ID.matcher(clientMessageId).matches()) {
            throw new InvalidChatRequestException("client_message_id inválido");
        }

        JsonNode board = collaboration.requireBoard(user.token(), boardId);
        var existing = messages.findByBoardIdAndSenderIdAndClientMessageId(boardId, user.id(), clientMessageId);
        if (existing.isPresent()) return new SendResult(existing.get(), false);
        List<String> recipients = collaboration.memberIds(user.token(), boardId).stream()
                .filter(id -> !id.equals(user.id()) && !sockets.isViewing(boardId, id)).distinct().toList();
        String messageId = UUID.randomUUID().toString();
        // MongoDB guarda milisegundos: la respuesta y los cursores deben usar
        // exactamente la misma precisión que la lectura posterior.
        Instant now = Instant.now().truncatedTo(ChronoUnit.MILLIS);
        Map<String, Object> event = new LinkedHashMap<>();
        event.put("event_id", messageId);
        event.put("type", "chat.message.created");
        event.put("occurred_at", now.toString());
        event.put("actor_id", user.id());
        event.put("board_id", boardId);
        event.put("recipient_ids", recipients);
        event.put("payload", Map.of(
                "board_name", board.path("name").asText("Tablero"),
                "actor_name", user.name(),
                "preview", text.length() > 120 ? text.substring(0, 120) : text));

        ChatMessage message = new ChatMessage(messageId, boardId, user.id(), user.name(), text,
                clientMessageId, now, event, recipients.isEmpty() ? "SENT" : "PENDING");
        try {
            // Mensaje y evento pendiente se insertan en UN documento atómico.
            // Funciona también con MongoDB standalone, sin transacciones multi-documento.
            ChatMessage saved = messages.insert(message);
            sockets.broadcast(boardId, saved);
            return new SendResult(saved, true);
        } catch (DuplicateKeyException duplicate) {
            ChatMessage prior = messages.findByBoardIdAndSenderIdAndClientMessageId(boardId, user.id(), clientMessageId)
                    .orElseThrow(() -> duplicate);
            return new SendResult(prior, false);
        }
    }

    private String encodeCursor(ChatMessage message) {
        String value = message.createdAt() + "|" + message.id();
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private Cursor decodeCursor(String value) {
        try {
            if (value.length() > 512) throw new IllegalArgumentException();
            String decoded = new String(Base64.getUrlDecoder().decode(value), StandardCharsets.UTF_8);
            int split = decoded.indexOf('|');
            if (split < 1) throw new IllegalArgumentException();
            String id = decoded.substring(split + 1);
            if (id.isBlank() || id.length() > 128) throw new IllegalArgumentException();
            return new Cursor(Instant.parse(decoded.substring(0, split)), id);
        } catch (RuntimeException invalid) {
            throw new InvalidChatRequestException("Cursor inválido");
        }
    }

    private record Cursor(Instant at, String id) {}
    public record SendResult(ChatMessage message, boolean created) {}
    public record ChatPage(List<ChatMessage> items, String nextCursor) {}
    public static class InvalidChatRequestException extends RuntimeException {
        public InvalidChatRequestException(String message) { super(message); }
    }
}
