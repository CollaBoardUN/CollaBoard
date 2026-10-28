package edu.collaboard.chat.service;

import com.fasterxml.jackson.databind.JsonNode;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.client.RestTemplate;
import org.springframework.boot.web.client.RestTemplateBuilder;

@Component
public class CollaborationClient implements BoardPermissions {
    private final RestTemplate http;
    private final String baseUrl;
    private final String boardsPath;

    public CollaborationClient(RestTemplateBuilder builder,
                               @Value("${collaboard.collaboration.url}") String baseUrl,
                               @Value("${collaboard.collaboration.boards-path:/boards}") String boardsPath,
                               @Value("${collaboard.collaboration.timeout-ms}") long timeoutMs) {
        this.http = builder.setConnectTimeout(Duration.ofMillis(timeoutMs))
                .setReadTimeout(Duration.ofMillis(timeoutMs)).build();
        this.baseUrl = baseUrl.replaceAll("/$", "");
        this.boardsPath = boardsPath.replaceAll("/$", "");
    }

    public JsonNode requireBoard(String token, String boardId) {
        try {
            JsonNode board = http.exchange(baseUrl + boardsPath + "/" + encode(boardId), HttpMethod.GET,
                    request(token), JsonNode.class).getBody();
            if (board == null || !board.isObject() || !board.path("id").asText().equals(boardId)) {
                throw new CollaborationUnavailableException();
            }
            return board;
        } catch (HttpStatusCodeException error) {
            if (error.getStatusCode() == HttpStatus.NOT_FOUND || error.getStatusCode() == HttpStatus.FORBIDDEN) {
                throw new BoardUnavailableException();
            }
            throw new CollaborationUnavailableException();
        } catch (org.springframework.web.client.RestClientException error) {
            throw new CollaborationUnavailableException();
        }
    }

    public List<String> memberIds(String token, String boardId) {
        try {
            JsonNode body = http.exchange(baseUrl + boardsPath + "/" + encode(boardId) + "/members",
                    HttpMethod.GET, request(token), JsonNode.class).getBody();
            List<String> ids = new ArrayList<>();
            if (body != null && body.isArray()) {
                body.forEach(member -> {
                    JsonNode id = member.get("user_id");
                    if (id == null || !id.isTextual() || id.asText().isBlank()) throw new CollaborationUnavailableException();
                    ids.add(id.asText());
                });
            } else throw new CollaborationUnavailableException();
            return ids;
        } catch (org.springframework.web.client.RestClientException error) {
            throw new CollaborationUnavailableException();
        }
    }

    private HttpEntity<Void> request(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.setBearerAuth(token);
        headers.setAccept(List.of(MediaType.APPLICATION_JSON));
        return new HttpEntity<>(headers);
    }

    private String encode(String value) {
        return java.net.URLEncoder.encode(value, java.nio.charset.StandardCharsets.UTF_8).replace("+", "%20");
    }

    public static class BoardUnavailableException extends RuntimeException {}
    public static class CollaborationUnavailableException extends RuntimeException {}
}
