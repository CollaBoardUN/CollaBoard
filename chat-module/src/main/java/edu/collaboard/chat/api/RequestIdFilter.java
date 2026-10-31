package edu.collaboard.chat.api;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class RequestIdFilter extends OncePerRequestFilter {
    private static final Logger log = LoggerFactory.getLogger(RequestIdFilter.class);
    @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String id = request.getHeader("X-Request-Id");
        if (id == null || !id.matches("[A-Za-z0-9._:-]{1,128}")) id = UUID.randomUUID().toString();
        response.setHeader("X-Request-Id", id);
        response.setHeader("Cache-Control", "no-store");
        long started = System.nanoTime();
        try { chain.doFilter(request, response); }
        finally {
            // Sin URL, query, cabeceras ni cuerpos: el JWT nunca llega al log.
            log.info("http request_id={} method={} status={} ms={}", id, request.getMethod(),
                    response.getStatus(), (System.nanoTime() - started) / 1_000_000);
        }
    }
}
