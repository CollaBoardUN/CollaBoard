package edu.collaboard.chat.data;

import com.fasterxml.jackson.annotation.JsonIgnore;
import java.time.Instant;
import java.util.Map;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.index.CompoundIndex;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.mapping.Field;

@Document("messages")
@CompoundIndex(name = "chat_idempotency", def = "{'boardId':1,'senderId':1,'clientMessageId':1}", unique = true)
@CompoundIndex(name = "chat_history", def = "{'boardId':1,'createdAt':1,'_id':1}")
@CompoundIndex(name = "chat_outbox", def = "{'notification_status':1,'createdAt':1}")
public record ChatMessage(
        @Id String id,
        String boardId,
        String senderId,
        String senderName,
        String text,
        String clientMessageId,
        Instant createdAt,
        @JsonIgnore @Field("notification_event") Map<String, Object> notificationEvent,
        @JsonIgnore @Field("notification_status") String notificationStatus) {
    public ChatMessage withNotificationStatus(String status) {
        return new ChatMessage(id, boardId, senderId, senderName, text, clientMessageId,
                createdAt, notificationEvent, status);
    }
}
