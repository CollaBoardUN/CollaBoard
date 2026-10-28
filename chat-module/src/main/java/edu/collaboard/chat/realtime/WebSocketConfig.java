package edu.collaboard.chat.realtime;

import java.net.URI;
import java.util.Arrays;
import java.util.Map;
import java.util.Set;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.http.server.ServerHttpRequest;
import org.springframework.http.server.ServerHttpResponse;
import org.springframework.http.server.ServletServerHttpRequest;
import org.springframework.web.socket.WebSocketHandler;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.HandshakeInterceptor;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {
    private final ChatSocketHandler handler;
    private final Set<String> origins;

    public WebSocketConfig(ChatSocketHandler handler,
            @Value("${collaboard.websocket.allowed-origins}") String allowedOrigins) {
        this.handler = handler;
        origins = Arrays.stream(allowedOrigins.split(",")).map(String::trim)
                .filter(value -> !value.isEmpty()).collect(Collectors.toUnmodifiableSet());
        if (origins.isEmpty()) throw new IllegalArgumentException("Configura CHAT_ALLOWED_ORIGINS");
        for (String origin : origins) {
            URI uri = URI.create(origin);
            if (origin.contains("*") || !("http".equals(uri.getScheme()) || "https".equals(uri.getScheme()))
                    || uri.getHost() == null || uri.getUserInfo() != null || uri.getQuery() != null
                    || uri.getFragment() != null || (uri.getPath() != null && !uri.getPath().isEmpty())) {
                throw new IllegalArgumentException("CHAT_ALLOWED_ORIGINS exige orígenes HTTP(S) explícitos sin ruta");
            }
        }
    }

    @Override public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(handler, "/ws/chat/boards/*")
                .addInterceptors(new HandshakeInterceptor() {
                    @Override public boolean beforeHandshake(ServerHttpRequest request, ServerHttpResponse response,
                            WebSocketHandler socket, Map<String, Object> attributes) {
                        String origin = request.getHeaders().getOrigin();
                        String authorization = request.getHeaders().getFirst("Authorization");
                        boolean bearer = authorization != null && authorization.regionMatches(true, 0, "Bearer ", 0, 7);
                        String token = bearer ? authorization.substring(7) : null;
                        // Electron puede omitir Origin usando Bearer. Una cookie
                        // de navegador solo se acepta con un Origin permitido.
                        if (origin != null && !origins.contains(origin)) {
                            response.setStatusCode(HttpStatus.FORBIDDEN); return false;
                        }
                        if (!bearer && request instanceof ServletServerHttpRequest servlet) {
                            var cookies = servlet.getServletRequest().getCookies();
                            if (cookies != null) for (var cookie : cookies) {
                                if ("cb_session".equals(cookie.getName())) token = cookie.getValue();
                            }
                            if (token != null && origin == null) {
                                response.setStatusCode(HttpStatus.FORBIDDEN); return false;
                            }
                        }
                        if (token != null) attributes.put("chatToken", token);
                        return true;
                    }
                    @Override public void afterHandshake(ServerHttpRequest request, ServerHttpResponse response,
                            WebSocketHandler socket, Exception exception) {}
                }).setAllowedOrigins(origins.toArray(String[]::new));
    }
}
