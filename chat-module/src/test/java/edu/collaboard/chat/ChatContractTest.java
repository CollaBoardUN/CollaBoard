package edu.collaboard.chat;

import static org.assertj.core.api.Assertions.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;
import edu.collaboard.chat.data.ChatMessage;
import edu.collaboard.chat.data.ChatMessageRepository;
import edu.collaboard.chat.realtime.ChatSocketHandler;
import edu.collaboard.chat.service.NotificationOutbox;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.net.http.WebSocket;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.data.mongodb.core.MongoTemplate;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/** HTTP/WS reales del módulo + MongoDB real desechable. Solo los otros servicios se simulan. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class ChatContractTest {
    static final String SECRET = "secreto-chat-contrato-java-con-mas-de-64-bytes-solo-para-pruebas-locales";
    static final String ORIGIN = "http://localhost:8088";
    static final ObjectMapper JSON = new ObjectMapper().findAndRegisterModules();
    static final Set<String> MEMBERS = ConcurrentHashMap.newKeySet();
    static final AtomicBoolean COLLAB_DOWN = new AtomicBoolean();
    static final AtomicBoolean NOTIFY_DOWN = new AtomicBoolean();
    static final List<JsonNode> EVENTS = new CopyOnWriteArrayList<>();
    static HttpServer collaboration;
    static HttpServer notifications;
    @LocalServerPort int port;
    @Autowired ChatMessageRepository messages;
    @Autowired MongoTemplate mongo;
    @Autowired NotificationOutbox outbox;
    @Autowired ChatSocketHandler sockets;
    final HttpClient client = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();
    final List<Probe> probes = new ArrayList<>();

    @DynamicPropertySource static void properties(DynamicPropertyRegistry properties) throws Exception {
        collaboration = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        collaboration.createContext("/boards/", exchange -> {
            String auth = exchange.getRequestHeaders().getFirst("Authorization");
            String user;
            try { user = SignedJWT.parse(auth.substring(7)).getJWTClaimsSet().getSubject(); }
            catch (Exception invalid) { user = "unknown"; }
            String path = exchange.getRequestURI().getPath();
            String board = path.substring("/boards/".length()).split("/")[0];
            int status = COLLAB_DOWN.get() ? 503 : !MEMBERS.contains(user) || !Set.of("b1", "b2").contains(board) ? 404 : 200;
            Object body = status != 200 ? Map.of("detail", "Sin acceso") : path.endsWith("/members")
                    ? MEMBERS.stream().map(id -> Map.of("user_id", id, "role", "viewer")).toList()
                    : Map.of("id", board, "name", "Ideas P2", "my_role", "viewer");
            byte[] data = JSON.writeValueAsBytes(body);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(status, data.length);
            exchange.getResponseBody().write(data);
            exchange.close();
        });
        collaboration.start();
        notifications = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        notifications.createContext("/internal/events", exchange -> {
            EVENTS.add(JSON.readTree(exchange.getRequestBody()));
            int status = !"test-service-token".equals(exchange.getRequestHeaders().getFirst("X-Service-Token"))
                    ? 401 : NOTIFY_DOWN.get() ? 503 : 202;
            exchange.sendResponseHeaders(status, -1);
            exchange.close();
        });
        notifications.start();
        String uri = System.getenv("TEST_MONGODB_URI");
        if (uri == null || uri.isBlank()) throw new IllegalStateException("Configura TEST_MONGODB_URI con MongoDB desechable; las pruebas borran messages en chat");
        properties.add("spring.data.mongodb.uri", () -> uri);
        properties.add("collaboard.jwt.secret", () -> SECRET);
        properties.add("collaboard.jwt.issuer", () -> "collaboard-auth");
        properties.add("collaboard.collaboration.url", () -> "http://127.0.0.1:" + collaboration.getAddress().getPort());
        properties.add("collaboard.notifications.url", () -> "http://127.0.0.1:" + notifications.getAddress().getPort());
        properties.add("collaboard.notifications.service-token", () -> "test-service-token");
        properties.add("collaboard.notifications.poll-ms", () -> "3600000");
        properties.add("collaboard.websocket.allowed-origins", () -> ORIGIN);
        properties.add("collaboard.websocket.recheck-ms", () -> "3600000");
    }

    @BeforeEach void reset() {
        messages.deleteAll();
        MEMBERS.clear(); MEMBERS.addAll(Set.of("ana", "beto"));
        COLLAB_DOWN.set(false); NOTIFY_DOWN.set(false); EVENTS.clear();
    }
    @AfterEach void disconnect() { probes.forEach(probe -> { if (probe.socket != null) probe.socket.abort(); }); }
    @AfterAll static void stopFixtures() { collaboration.stop(0); notifications.stop(0); }

    static String token(String user) throws Exception {
        return token(user, "collaboard-auth", Instant.now().plusSeconds(600), SECRET, JWSAlgorithm.HS256);
    }
    static String token(String user, String issuer, Instant expires, String secret, JWSAlgorithm algorithm) throws Exception {
        var claims = new JWTClaimsSet.Builder().subject(user).issuer(issuer).claim("name", "Nombre " + user)
                .issueTime(new Date());
        if (expires != null) claims.expirationTime(Date.from(expires));
        SignedJWT jwt = new SignedJWT(new JWSHeader(algorithm), claims.build());
        jwt.sign(new MACSigner(secret));
        return jwt.serialize();
    }
    HttpResponse<String> call(String method, String path, String token, Object body) throws Exception {
        var builder = HttpRequest.newBuilder(URI.create("http://127.0.0.1:" + port + path))
                .timeout(Duration.ofSeconds(8)).header("X-Request-Id", "contract-request-1");
        if (token != null) builder.header("Authorization", "Bearer " + token);
        if (body == null) builder.method(method, HttpRequest.BodyPublishers.noBody());
        else builder.header("Content-Type", "application/json").method(method,
                HttpRequest.BodyPublishers.ofString(body instanceof String s ? s : JSON.writeValueAsString(body)));
        return client.send(builder.build(), HttpResponse.BodyHandlers.ofString());
    }
    HttpResponse<String> post(String user, String text, String id) throws Exception {
        return call("POST", "/api/chat/boards/b1/messages", token(user), Map.of("text", text, "client_message_id", id));
    }
    JsonNode body(HttpResponse<String> response) throws Exception { return JSON.readTree(response.body()); }
    JsonNode page(String query) throws Exception {
        var response = call("GET", "/api/chat/boards/b1/messages" + query, token("ana"), null);
        assertThat(response.statusCode()).isEqualTo(200); return body(response);
    }

    @Test void validatesJwtLikeGoAuthAndReturnsSafeCorrelatedErrors() throws Exception {
        assertThat(call("GET", "/api/chat/boards/b1/messages", null, null).statusCode()).isEqualTo(401);
        for (String invalid : List.of(
                token("ana", "wrong", Instant.now().plusSeconds(600), SECRET, JWSAlgorithm.HS256),
                token("ana", "collaboard-auth", Instant.now().minusSeconds(10), SECRET, JWSAlgorithm.HS256),
                token("ana", "collaboard-auth", null, SECRET, JWSAlgorithm.HS256),
                token("ana", "collaboard-auth", Instant.now().plusSeconds(600), SECRET + "forged", JWSAlgorithm.HS256),
                token("ana", "collaboard-auth", Instant.now().plusSeconds(600), SECRET, JWSAlgorithm.HS512),
                token("", "collaboard-auth", Instant.now().plusSeconds(600), SECRET, JWSAlgorithm.HS256))) {
            var response = call("GET", "/api/chat/boards/b1/messages", invalid, null);
            assertThat(response.statusCode()).isEqualTo(401);
            assertThat(body(response).path("detail").asText()).isEqualTo("No autenticado");
            assertThat(response.headers().firstValue("X-Request-Id")).contains("contract-request-1");
            assertThat(response.body()).doesNotContain(invalid);
        }
    }

    @Test void rejectsOutsidersAndMissingBoardsAndFailsClosedWhenCollaborationIsDown() throws Exception {
        assertThat(post("carla", "hola", "outsider-0001").statusCode()).isEqualTo(404);
        assertThat(call("GET", "/api/chat/boards/missing/messages", token("ana"), null).statusCode()).isEqualTo(404);
        COLLAB_DOWN.set(true);
        assertThat(post("ana", "hola", "unavailable-1").statusCode()).isEqualTo(503);
        assertThat(messages.count()).isZero();
    }

    @Test void createsThenRetriesTheSameMessageAndNeverTrustsBodyIdentity() throws Exception {
        var first = call("POST", "/api/chat/boards/b1/messages", token("ana"), Map.of(
                "text", "  Hola equipo  ", "client_message_id", "idempotency-1", "sender_id", "beto", "sender_name", "Falso"));
        assertThat(first.statusCode()).isEqualTo(201);
        var retry = post("ana", "texto distinto", "idempotency-1");
        assertThat(retry.statusCode()).isEqualTo(200);
        assertThat(body(retry)).isEqualTo(body(first));
        JsonNode message = body(first);
        assertThat(message.path("text").asText()).isEqualTo("Hola equipo");
        assertThat(message.path("sender_id").asText()).isEqualTo("ana");
        assertThat(message.path("sender_name").asText()).isEqualTo("Nombre ana");
        assertThat(message.has("notification_event")).isFalse();
        assertThat(message.has("notification_status")).isFalse();
        assertThat(messages.count()).isEqualTo(1);
        assertThat(post("beto", "otra persona", "idempotency-1").statusCode()).isEqualTo(201);
        assertThat(call("POST", "/api/chat/boards/b2/messages", token("ana"), Map.of(
                "text", "otro tablero", "client_message_id", "idempotency-1")).statusCode()).isEqualTo(201);
    }

    @Test void concurrentDuplicatesHaveExactlyOneInsertAndOneDurableEvent() throws Exception {
        try (var executor = Executors.newFixedThreadPool(6)) {
            var tasks = new ArrayList<java.util.concurrent.Callable<HttpResponse<String>>>();
            for (int i = 0; i < 6; i++) tasks.add(() -> post("ana", "simultáneo", "concurrent-0001"));
            var results = executor.invokeAll(tasks);
            Set<String> ids = new java.util.HashSet<>(); int created = 0;
            for (var result : results) {
                var response = result.get();
                assertThat(response.statusCode()).isIn(200, 201);
                if (response.statusCode() == 201) created++;
                ids.add(body(response).path("id").asText());
            }
            assertThat(created).isEqualTo(1); assertThat(ids).hasSize(1);
            assertThat(messages.count()).isEqualTo(1);
        }
    }

    @Test void validatesTrimmedTextAndClientIdsAndMalformedBodies() throws Exception {
        for (String text : List.of("", "   ", "\u00a0\ufeff", "x".repeat(2001))) {
            assertThat(post("ana", text, "validation-001").statusCode()).isEqualTo(422);
        }
        for (String id : List.of("short", "x".repeat(65), "invalid_00001")) {
            assertThat(post("ana", "hola", id).statusCode()).isEqualTo(422);
        }
        assertThat(post("ana", " " + "x".repeat(2000) + " ", "max-length-01").statusCode()).isEqualTo(201);
        assertThat(call("POST", "/api/chat/boards/b1/messages", token("ana"), "{").statusCode()).isEqualTo(422);
        assertThat(call("POST", "/api/chat/boards/b1/messages", token("ana"), Map.of()).statusCode()).isEqualTo(422);
        assertThat(call("POST", "/api/chat/boards/b1/messages", token("ana"), Map.of(
                "text", 123, "client_message_id", "numeric-0001")).statusCode()).isEqualTo(422);
    }

    @Test void pagesBeforeAndRecoversAfterChronologically() throws Exception {
        for (int i = 0; i < 5; i++) {
            post("beto", "m" + i, "pagination-000" + i);
            Thread.sleep(3); // separar las fechas de este escenario; los empates se prueban aparte
        }
        JsonNode latest = page("?limit=2");
        assertThat(latest.path("items").findValuesAsText("text")).containsExactly("m3", "m4");
        String cursor = latest.path("next_cursor").asText();
        JsonNode older = page("?limit=2&before=" + cursor);
        assertThat(older.path("items").findValuesAsText("text")).containsExactly("m1", "m2");
        JsonNode recovered = page("?after=" + older.path("items").get(1).path("id").asText());
        assertThat(recovered.path("items").findValuesAsText("text")).containsExactly("m3", "m4");
        assertThat(recovered.path("next_cursor").isNull()).isTrue();
        assertThat(page("?limit=2&before=" + older.path("next_cursor").asText()).path("next_cursor").isNull()).isTrue();
    }

    @Test void paginationUsesIdTieBreakerAtMongoMillisecondPrecisionAndIsBoardScoped() throws Exception {
        Instant at = Instant.parse("2026-10-27T10:00:00Z");
        for (String id : List.of("a", "b", "c", "d")) messages.insert(new ChatMessage(
                id, "b1", "ana", "Ana", id, "tie-0000" + id, at, Map.of(), "SENT"));
        var latest = page("?limit=2");
        assertThat(latest.path("items").findValuesAsText("id")).containsExactly("c", "d");
        assertThat(page("?limit=2&before=" + latest.path("next_cursor").asText()).path("items").findValuesAsText("id"))
                .containsExactly("a", "b");
        assertThat(page("?after=b").path("items").findValuesAsText("id")).containsExactly("c", "d");
        messages.insert(new ChatMessage("other", "b2", "ana", "Ana", "other", "other-00001", at, Map.of(), "SENT"));
        assertThat(call("GET", "/api/chat/boards/b1/messages?after=other", token("ana"), null).statusCode()).isEqualTo(422);
        for (String query : List.of("?limit=0", "?limit=101", "?limit=no", "?before=bad", "?before=x&after=y")) {
            assertThat(call("GET", "/api/chat/boards/b1/messages" + query, token("ana"), null).statusCode()).isEqualTo(422);
        }
        assertThat(mongo.getDb().getName()).isEqualTo("chat");
        assertThat(mongo.indexOps(ChatMessage.class).getIndexInfo().stream().map(index -> index.getName()))
                .contains("chat_idempotency", "chat_history", "chat_outbox");
    }

    @Test void outboxIsDurableAtomicAndRetriesStableEventExcludingAuthor() throws Exception {
        var response = post("ana", "para Beto", "notification-1");
        String id = body(response).path("id").asText();
        var stored = messages.findById(id).orElseThrow();
        assertThat(stored.notificationStatus()).isEqualTo("PENDING");
        assertThat(stored.notificationEvent().get("recipient_ids")).isEqualTo(List.of("beto"));
        NOTIFY_DOWN.set(true); outbox.dispatchPending();
        assertThat(messages.findById(id).orElseThrow().notificationStatus()).isEqualTo("PENDING");
        NOTIFY_DOWN.set(false); outbox.dispatchPending();
        assertThat(messages.findById(id).orElseThrow().notificationStatus()).isEqualTo("SENT");
        assertThat(EVENTS).hasSize(2);
        assertThat(EVENTS.get(0)).isEqualTo(EVENTS.get(1));
        assertThat(EVENTS.get(0).path("event_id").asText()).isEqualTo(id);
        outbox.dispatchPending(); assertThat(EVENTS).hasSize(2);
    }

    @Test void healthIsPublic() throws Exception {
        var health = call("GET", "/health", null, null);
        assertThat(health.statusCode()).isEqualTo(200);
        assertThat(body(health).path("service").asText()).isEqualTo("chat-api");
    }

    class Probe implements WebSocket.Listener {
        WebSocket socket;
        final BlockingQueue<JsonNode> received = new LinkedBlockingQueue<>();
        final CompletableFuture<Integer> closed = new CompletableFuture<>();
        final StringBuilder partial = new StringBuilder();
        @Override public void onOpen(WebSocket socket) { this.socket = socket; socket.request(1); }
        @Override public CompletionStage<?> onText(WebSocket socket, CharSequence text, boolean last) {
            partial.append(text);
            if (last) {
                try { received.add(JSON.readTree(partial.toString())); }
                catch (Exception invalid) { throw new AssertionError(invalid); }
                partial.setLength(0);
            }
            socket.request(1); return null;
        }
        @Override public CompletionStage<?> onClose(WebSocket socket, int code, String reason) { closed.complete(code); return null; }
        @Override public void onError(WebSocket socket, Throwable error) { closed.completeExceptionally(error); }
        JsonNode next() throws Exception {
            JsonNode result = received.poll(5, TimeUnit.SECONDS);
            assertThat(result).as("mensaje WS esperado").isNotNull(); return result;
        }
        void ping() throws Exception { socket.sendText("{\"type\":\"ping\"}", true).join(); assertThat(next().path("type").asText()).isEqualTo("pong"); }
    }
    Probe connect(String token, boolean cookie, String origin, String board) {
        Probe probe = new Probe(); probes.add(probe);
        var builder = client.newWebSocketBuilder().connectTimeout(Duration.ofSeconds(5));
        if (origin != null) builder.header("Origin", origin);
        if (token != null) builder.header(cookie ? "Cookie" : "Authorization", cookie ? "cb_session=" + token : "Bearer " + token);
        probe.socket = builder.buildAsync(URI.create("ws://127.0.0.1:" + port + "/ws/chat/boards/" + board), probe).join();
        return probe;
    }

    @Test void webSocketSupportsCookieAndBearerButNeverWritesAndDoesNotRepeatRetries() throws Exception {
        Probe browser = connect(token("beto"), true, ORIGIN, "b1"); browser.ping();
        Probe electron = connect(token("ana"), false, null, "b1"); electron.ping();
        Probe otherBoard = connect(token("beto"), true, ORIGIN, "b2"); otherBoard.ping();
        browser.socket.sendText("{", true).join();
        assertThat(browser.next().path("code").asText()).isEqualTo("bad_message");
        browser.socket.sendText("{\"type\":\"message\",\"text\":\"no guardar\"}", true).join();
        assertThat(browser.next().path("code").asText()).isEqualTo("http_only");
        assertThat(messages.count()).isZero();
        post("ana", "en vivo", "live-message-1");
        assertThat(browser.next().path("message").path("text").asText()).isEqualTo("en vivo");
        assertThat(electron.next().path("type").asText()).isEqualTo("message");
        post("ana", "en vivo", "live-message-1");
        browser.ping(); // si hubiera eco duplicado, next() devolvería message y fallaría
        assertThat(otherBoard.received).isEmpty();
    }

    @Test void webSocketRejectsSessionAndMembershipAndUntrustedOrigins() throws Exception {
        assertThat(connect(null, false, ORIGIN, "b1").closed.get(5, TimeUnit.SECONDS)).isEqualTo(4401);
        assertThat(connect(token("carla"), true, ORIGIN, "b1").closed.get(5, TimeUnit.SECONDS)).isEqualTo(4403);
        assertThatThrownBy(() -> connect(token("ana"), true, "https://evil.example", "b1")).hasCauseInstanceOf(java.net.http.WebSocketHandshakeException.class);
        assertThatThrownBy(() -> connect(token("ana"), false, "https://evil.example", "b1")).hasCauseInstanceOf(java.net.http.WebSocketHandshakeException.class);
        assertThatThrownBy(() -> connect(token("ana"), true, null, "b1")).hasCauseInstanceOf(java.net.http.WebSocketHandshakeException.class);
    }

    @Test void removedMembersCannotReceiveAnotherMessageOrReadOrSend() throws Exception {
        Probe removed = connect(token("beto"), true, ORIGIN, "b1"); removed.ping();
        MEMBERS.remove("beto");
        post("ana", "privado", "removed-member-1");
        assertThat(removed.closed.get(5, TimeUnit.SECONDS)).isEqualTo(4403);
        assertThat(removed.received).isEmpty();
        assertThat(post("beto", "no", "removed-post-01").statusCode()).isEqualTo(404);
        assertThat(call("GET", "/api/chat/boards/b1/messages", token("beto"), null).statusCode()).isEqualTo(404);
    }

    @Test void periodicRecheckDisconnectsRemovedMembersEvenWithoutNewMessages() throws Exception {
        Probe removed = connect(token("beto"), true, ORIGIN, "b1"); removed.ping();
        MEMBERS.remove("beto"); sockets.revalidate();
        assertThat(removed.closed.get(5, TimeUnit.SECONDS)).isEqualTo(4403);
    }

    @Test void websocketFailsClosedWhenPermissionServiceGoesDown() throws Exception {
        Probe member = connect(token("beto"), true, ORIGIN, "b1"); member.ping();
        COLLAB_DOWN.set(true); sockets.revalidate();
        assertThat(member.next().path("code").asText()).isEqualTo("unavailable");
        assertThat(member.closed.get(5, TimeUnit.SECONDS)).isEqualTo(1011);
    }

    @Test void websocketRechecksJwtExpirationAfterHandshake() throws Exception {
        String shortToken = token("beto", "collaboard-auth", Instant.now().plusSeconds(3), SECRET, JWSAlgorithm.HS256);
        Probe member = connect(shortToken, true, ORIGIN, "b1"); member.ping();
        org.awaitility.Awaitility.await().atMost(Duration.ofSeconds(5)).until(() -> {
            sockets.revalidate(); return member.closed.isDone();
        });
        assertThat(member.closed.get(1, TimeUnit.SECONDS)).isEqualTo(4401);
    }
}
