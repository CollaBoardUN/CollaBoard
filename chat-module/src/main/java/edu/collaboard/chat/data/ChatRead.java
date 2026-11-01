package edu.collaboard.chat.data;

import com.fasterxml.jackson.annotation.JsonIgnore;
import java.time.Instant;
import org.springframework.data.annotation.Id;
import org.springframework.data.mongodb.core.mapping.Document;
import org.springframework.data.mongodb.core.index.Indexed;

@Document("read_receipts")
public record ChatRead(@Id @JsonIgnore String id, @Indexed String boardId, String userId,
                       String userName, String messageId, Instant messageCreatedAt, Instant readAt) {}
