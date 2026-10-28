package edu.collaboard.chat.data;

import java.util.Optional;
import org.springframework.data.mongodb.repository.MongoRepository;

public interface ChatMessageRepository extends MongoRepository<ChatMessage, String> {
    Optional<ChatMessage> findByBoardIdAndSenderIdAndClientMessageId(
            String boardId, String senderId, String clientMessageId);
}
