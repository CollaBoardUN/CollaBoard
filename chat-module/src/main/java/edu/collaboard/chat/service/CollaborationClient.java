package edu.collaboard.chat.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.web.client.RestTemplateBuilder;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestTemplate;

/**
 * Policy Enforcement Point (PEP) de Chat con caché de decisiones (Cache-Aside · Escenario S5).
 *
 * Consulta al PDP (collaboration-api) por el contrato interno /internal/boards/{id}/access
 * enviando X-Service-Token y el JWT del usuario, y cachea la decisión durante cacheTtlMs
 * (por defecto 2 000 ms; 0 = sin caché). Si Colaboración falla o no responde, falla cerrado.
 */
@Component
public class CollaborationClient implements BoardPermissions {
    private static final ObjectMapper MAPPER = new ObjectMapper();
    private final RestTemplate http;
    private final String baseUrl;
    private final String boardsPath;
    private final String serviceToken;
    private final long cacheTtlMs;
    private final ConcurrentMap<String, CachedDecision> decisionCache = new ConcurrentHashMap<>();

    private record CachedDecision(
            JsonNode board,
            Set<String> permissions,
            long expiresAtMs) {}

    public CollaborationClient(
            RestTemplateBuilder builder,
            @Value("${collaboard.collaboration.url}") String baseUrl,
            @Value("${collaboard.collaboration.boards-path:/internal/boards}") String boardsPath,
            @Value("${collaboard.collaboration.timeout-ms:4000}") long timeoutMs,
            @Value("${collaboard.collaboration.service-token:${collaboard.notifications.service-token:}}") String serviceToken,
            @Value("${collaboard.collaboration.cache-ttl-ms:2000}") long cacheTtlMs) {
        this.http = builder.setConnectTimeout(Duration.ofMillis(timeoutMs))
                .setReadTimeout(Duration.ofMillis(timeoutMs)).build();
        this.baseUrl = baseUrl.replaceAll("/$", "");
        this.boardsPath = boardsPath.replaceAll("/$", "");
        this.serviceToken = serviceToken == null ? "" : serviceToken;
        this.cacheTtlMs = Math.max(0L, cacheTtlMs);
    }

    @Override
    public JsonNode requireBoard(String token, String boardId) {
        return requireAction(token, boardId, "chat:read");
    }

    @Override
    public JsonNode requireAction(String token, String boardId, String action) {
        String cacheKey = boardId + "|" + token;
        long now = System.currentTimeMillis();
        if (cacheTtlMs > 0) {
            CachedDecision hit = decisionCache.get(cacheKey);
            if (hit != null && hit.expiresAtMs() > now) {
                if (!hit.permissions().isEmpty() && action != null && !hit.permissions().contains(action)) {
                    throw new ActionForbiddenException();
                }
                return hit.board();
            }
        }

        boolean isInternal = boardsPath.contains("/internal/");
        String url = isInternal
                ? baseUrl + boardsPath + "/" + encode(boardId) + "/access"
                    + (action != null ? "?action=" + encode(action) : "")
                : baseUrl + boardsPath + "/" + encode(boardId);
        try {
            JsonNode body = http.exchange(url, HttpMethod.GET, request(token), JsonNode.class).getBody();
            if (body == null || !body.isObject()) {
                throw new CollaborationUnavailableException();
            }
            String resolvedBoardId = body.hasNonNull("board_id")
                    ? body.path("board_id").asText()
                    : body.path("id").asText();
            if (!boardId.equals(resolvedBoardId)) {
                throw new CollaborationUnavailableException();
            }
            if (body.has("allowed") && !body.path("allowed").asBoolean(true)) {
                throw new ActionForbiddenException();
            }

            ObjectNode normalized = body.deepCopy();
            if (!normalized.hasNonNull("id")) {
                normalized.put("id", resolvedBoardId);
            }
            if (!normalized.hasNonNull("name") && normalized.hasNonNull("board_name")) {
                normalized.put("name", normalized.path("board_name").asText());
            }

            Set<String> perms = new HashSet<>();
            JsonNode permsNode = body.get("permissions");
            if (permsNode != null && permsNode.isArray()) {
                permsNode.forEach(p -> {
                    if (p != null && p.isTextual()) perms.add(p.asText());
                });
            }
            if (cacheTtlMs > 0) {
                decisionCache.put(cacheKey, new CachedDecision(normalized, perms, now + cacheTtlMs));
            }
            return normalized;
        } catch (HttpStatusCodeException error) {
            decisionCache.remove(cacheKey);
            if (error.getStatusCode() == HttpStatus.NOT_FOUND || error.getStatusCode() == HttpStatus.FORBIDDEN) {
                throw new BoardUnavailableException();
            }
            throw new CollaborationUnavailableException();
        } catch (org.springframework.web.client.RestClientException error) {
            throw new CollaborationUnavailableException();
        }
    }

    @Override
    public List<String> memberIds(String token, String boardId) {
        boolean isInternal = boardsPath.contains("/internal/");
        String suffix = isInternal ? "/recipients" : "/members";
        try {
            JsonNode body = http.exchange(baseUrl + boardsPath + "/" + encode(boardId) + suffix,
                    HttpMethod.GET, request(token), JsonNode.class).getBody();
            List<String> ids = new ArrayList<>();
            if (body != null && body.isObject() && body.has("recipient_ids") && body.get("recipient_ids").isArray()) {
                body.get("recipient_ids").forEach(node -> {
                    if (node == null || !node.isTextual() || node.asText().isBlank()) {
                        throw new CollaborationUnavailableException();
                    }
                    ids.add(node.asText());
                });
                return ids;
            }
            if (body != null && body.isArray()) {
                body.forEach(member -> {
                    JsonNode id = member.get("user_id");
                    if (id == null || !id.isTextual() || id.asText().isBlank()) {
                        throw new CollaborationUnavailableException();
                    }
                    ids.add(id.asText());
                });
                return ids;
            }
            throw new CollaborationUnavailableException();
        } catch (org.springframework.web.client.RestClientException error) {
            throw new CollaborationUnavailableException();
        }
    }

    @Override
    public void invalidateBoard(String boardId) {
        if (boardId == null || boardId.isBlank()) {
            decisionCache.clear();
            return;
        }
        String prefix = boardId + "|";
        decisionCache.keySet().removeIf(k -> k.startsWith(prefix));
    }

    private HttpEntity<Void> request(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setAccept(List.of(MediaType.APPLICATION_JSON));
        if (!serviceToken.isBlank()) {
            headers.set("X-Service-Token", serviceToken);
        }
        return new HttpEntity<>(headers);
    }

    private String encode(String value) {
        return java.net.URLEncoder.encode(value, java.nio.charset.StandardCharsets.UTF_8).replace("+", "%20");
    }

    public static class BoardUnavailableException extends RuntimeException {}
    public static class ActionForbiddenException extends RuntimeException {}
    public static class CollaborationUnavailableException extends RuntimeException {}
}
