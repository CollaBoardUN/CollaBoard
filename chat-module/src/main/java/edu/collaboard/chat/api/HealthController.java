package edu.collaboard.chat.api;

import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.http.ResponseEntity;

@RestController
public class HealthController {
    private final MongoTemplate mongo;
    public HealthController(MongoTemplate mongo) { this.mongo = mongo; }
    @GetMapping("/health")
    public ResponseEntity<Map<String, String>> health() {
        try {
            mongo.executeCommand("{ping:1}");
            return ResponseEntity.ok(Map.of("status", "ok", "service", "chat-api"));
        } catch (org.springframework.dao.DataAccessException unavailable) {
            return ResponseEntity.status(503).body(Map.of("status", "unavailable", "service", "chat-api"));
        }
    }
}
