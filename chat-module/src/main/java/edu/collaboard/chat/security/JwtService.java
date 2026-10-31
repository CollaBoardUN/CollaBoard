package edu.collaboard.chat.security;

import javax.crypto.SecretKey;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import java.time.Duration;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.jwt.JwtClaimValidator;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.JwtTimestampValidator;
import org.springframework.security.oauth2.jose.jws.MacAlgorithm;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;
import org.springframework.stereotype.Service;

@Service
public class JwtService {
    private final JwtDecoder decoder;

    public JwtService(@Value("${collaboard.jwt.secret}") String secret,
                      @Value("${collaboard.jwt.issuer}") String issuer) {
        if (secret == null || secret.getBytes(java.nio.charset.StandardCharsets.UTF_8).length < 32) {
            throw new IllegalStateException("JWT_SECRET debe tener al menos 32 bytes");
        }
        SecretKey key = new SecretKeySpec(secret.getBytes(java.nio.charset.StandardCharsets.UTF_8), "HmacSHA256");
        NimbusJwtDecoder jwtDecoder = NimbusJwtDecoder.withSecretKey(key).macAlgorithm(MacAlgorithm.HS256).build();
        jwtDecoder.setJwtValidator(new DelegatingOAuth2TokenValidator<Jwt>(
                new JwtIssuerValidator(issuer), new JwtTimestampValidator(Duration.ZERO),
                new JwtClaimValidator<Object>("exp", value -> value != null)));
        this.decoder = jwtDecoder;
    }

    public ChatPrincipal authenticate(String token) {
        if (token == null || token.isBlank()) throw new JwtException("Token ausente");
        Jwt jwt = decoder.decode(token);
        String id = jwt.getSubject();
        if (id == null || id.isBlank()) throw new JwtException("El token no trae subject");
        String name = jwt.getClaimAsString("name");
        if (name == null || name.isBlank()) name = jwt.getClaimAsString("email");
        if (name == null || name.isBlank()) name = id;
        return new ChatPrincipal(id, name, token);
    }
}
