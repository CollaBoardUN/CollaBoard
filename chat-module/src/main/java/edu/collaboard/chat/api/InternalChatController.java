package edu.collaboard.chat.api;

import edu.collaboard.chat.data.ChatMessage;
import edu.collaboard.chat.data.ChatRead;
import edu.collaboard.chat.realtime.ChatSocketHandler;
import edu.collaboard.chat.service.BoardPermissions;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * Endpoint interno idempotente invocado por el outbox de Colaboración al borrar un tablero.
 *
 * Invalida la caché del PEP de Chat, cierra las sesiones WebSocket activas con 4403 y
 * elimina los mensajes y recibos de lectura del tablero en MongoDB.
 */
@RestController
@RequestMapping("/internal/chat/boards")
public class InternalChatController {
    private final MongoTemplate mongo;
    private final BoardPermissions permissions;
    private final ChatSocketHandler sockets;
    private final byte[] serviceTokenBytes;

    public InternalChatController(
            MongoTemplate mongo,
            BoardPermissions permissions,
            ChatSocketHandler sockets,
            @Value("${collaboard.collaboration.service-token:${collaboard.notifications.service-token:}}") String serviceToken) {
        this.mongo = mongo;
        this.permissions = permissions;
        this.sockets = sockets;
        this.serviceTokenBytes = (serviceToken == null ? "" : serviceToken).getBytes(StandardCharsets.UTF_8);
    }

    @DeleteMapping("/{boardId}")
    public ResponseEntity<?> purgeBoard(
            @PathVariable String boardId,
            @RequestHeader(value = "X-Service-Token", required = false) String givenToken) {
        if (serviceTokenBytes.length == 0 || givenToken == null
                || !MessageDigest.isEqual(serviceTokenBytes, givenToken.getBytes(StandardCharsets.UTF_8))) {
            return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                    .body(Map.of("detail", "Credencial de servicio inválida o ausente"));
        }
        permissions.invalidateBoard(boardId);
        sockets.closeBoardConnections(boardId);
        Query byBoard = Query.query(Criteria.where("boardId").is(boardId));
        mongo.remove(byBoard, ChatMessage.class);
        mongo.remove(byBoard, ChatRead.class);
        return ResponseEntity.noContent().build();
    }
}
