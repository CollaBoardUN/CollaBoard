package edu.collaboard.chat.service;

import edu.collaboard.chat.data.ChatMessage;
import java.time.Duration;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.data.mongodb.core.query.Criteria;
import org.springframework.data.mongodb.core.query.Query;
import org.springframework.data.mongodb.core.query.Update;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestTemplate;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

@Component
public class NotificationOutbox {
    private static final Logger log = LoggerFactory.getLogger(NotificationOutbox.class);
    private final MongoTemplate mongo;
    private final RestTemplate http;
    private final String url;
    private final String serviceToken;

    public NotificationOutbox(MongoTemplate mongo, RestTemplateBuilder builder,
                              @Value("${collaboard.notifications.url}") String url,
                              @Value("${collaboard.notifications.service-token}") String serviceToken) {
        this.mongo = mongo;
        this.http = builder.setConnectTimeout(Duration.ofSeconds(3)).setReadTimeout(Duration.ofSeconds(4)).build();
        this.url = url.replaceAll("/$", "") + "/internal/events";
        this.serviceToken = serviceToken;
        if (serviceToken.isBlank()) throw new IllegalArgumentException("Configura NOTIFICATIONS_SERVICE_TOKEN");
    }

    @Scheduled(fixedDelayString = "${collaboard.notifications.poll-ms:4000}",
            initialDelayString = "${collaboard.notifications.poll-ms:4000}")
    public void dispatchPending() {
        Query query = new Query(Criteria.where("notificationStatus").is("PENDING"))
                .with(org.springframework.data.domain.Sort.by("createdAt")).limit(50);
        List<ChatMessage> pending;
        try { pending = mongo.find(query, ChatMessage.class); }
        catch (org.springframework.dao.DataAccessException unavailable) {
            log.warn("Almacenamiento de outbox no disponible; se reintentará");
            return;
        }
        for (ChatMessage message : pending) {
            try {
                HttpHeaders headers = new HttpHeaders();
                headers.setContentType(MediaType.APPLICATION_JSON);
                headers.set("X-Service-Token", serviceToken);
                var response = http.exchange(url, HttpMethod.POST,
                        new HttpEntity<>(message.notificationEvent(), headers), String.class);
                if (response.getStatusCode().value() == 202) setStatus(message.id(), "SENT");
                else log.warn("NotificationAPI respondió {} para el evento {}", response.getStatusCode(), message.id());
            } catch (Exception error) {
                // No registrar el cuerpo remoto ni la excepción (pueden contener secretos).
                log.warn("Evento {} queda pendiente para reintento ({})", message.id(), error.getClass().getSimpleName());
            }
        }
    }

    private void setStatus(String id, String status) {
        mongo.updateFirst(Query.query(Criteria.where("_id").is(id)),
                Update.update("notification_status", status), ChatMessage.class);
    }
}
