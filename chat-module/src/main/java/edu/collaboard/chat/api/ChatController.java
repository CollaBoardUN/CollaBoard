package edu.collaboard.chat.api;

import edu.collaboard.chat.data.ChatMessage;
import edu.collaboard.chat.security.ChatPrincipal;
import edu.collaboard.chat.service.ChatService;
import com.fasterxml.jackson.databind.JsonNode;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.bind.MethodArgumentNotValidException;

@RestController
@RequestMapping("/api/chat/boards/{boardId}/messages")
public class ChatController {
    private final ChatService chat;
    public ChatController(ChatService chat) { this.chat = chat; }

    @GetMapping
    public ChatService.ChatPage history(@PathVariable String boardId,
                                        @AuthenticationPrincipal ChatPrincipal user,
                                        @RequestParam(defaultValue = "30") int limit,
                                        @RequestParam(required = false) String before,
                                        @RequestParam(required = false) String after) {
        return chat.history(boardId, user, limit, before, after);
    }

    @PostMapping
    public ResponseEntity<ChatMessage> send(@PathVariable String boardId, @AuthenticationPrincipal ChatPrincipal user,
                                            @RequestBody SendMessageRequest request) {
        // Jackson puede convertir números a String por defecto. El contrato
        // exige cadenas, así que se comprueba el tipo JSON explícitamente.
        if (request.text() == null || !request.text().isTextual()
                || request.clientMessageId() == null || !request.clientMessageId().isTextual()) {
            throw new ChatService.InvalidChatRequestException("Mensaje inválido");
        }
        ChatService.SendResult result = chat.send(boardId, user, request.text().textValue(), request.clientMessageId().textValue());
        return ResponseEntity.status(result.created() ? HttpStatus.CREATED : HttpStatus.OK).body(result.message());
    }

    public record SendMessageRequest(
            JsonNode text, JsonNode clientMessageId) {}
}

@RestControllerAdvice
class ChatErrorHandler {
    @ExceptionHandler(edu.collaboard.chat.service.CollaborationClient.BoardUnavailableException.class)
    ResponseEntity<Map<String, String>> boardUnavailable(RuntimeException error) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("detail", "Tablero no encontrado"));
    }

    @ExceptionHandler(edu.collaboard.chat.service.CollaborationClient.CollaborationUnavailableException.class)
    ResponseEntity<Map<String, String>> collaborationUnavailable(RuntimeException error) {
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE).body(Map.of("detail", "Colaboración no responde"));
    }

    @ExceptionHandler(ChatService.InvalidChatRequestException.class)
    ResponseEntity<Map<String, String>> invalid(ChatService.InvalidChatRequestException error) {
        return ResponseEntity.unprocessableEntity().body(Map.of("detail", error.getMessage()));
    }

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<Map<String, String>> invalidBody(MethodArgumentNotValidException error) {
        return ResponseEntity.unprocessableEntity().body(Map.of("detail", "Mensaje inválido"));
    }

    @ExceptionHandler({org.springframework.http.converter.HttpMessageNotReadableException.class,
            org.springframework.web.method.annotation.MethodArgumentTypeMismatchException.class})
    ResponseEntity<Map<String, String>> malformed(Exception error) {
        return ResponseEntity.unprocessableEntity().body(Map.of("detail", "Solicitud inválida"));
    }

    @ExceptionHandler(org.springframework.dao.DataAccessException.class)
    ResponseEntity<Map<String, String>> databaseUnavailable(Exception error) {
        return ResponseEntity.status(503).body(Map.of("detail", "El almacenamiento de Chat no responde"));
    }
}
