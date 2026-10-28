package edu.collaboard.chat;

import static org.assertj.core.api.Assertions.*;
import edu.collaboard.chat.realtime.WebSocketConfig;
import edu.collaboard.chat.security.ChatPrincipal;
import edu.collaboard.chat.security.JwtService;
import org.junit.jupiter.api.Test;

class SecurityConfigurationTest {
    @Test void rejectsWildcardOriginsAndEmptyOrNonOriginValues() {
        for (String value : new String[]{"*", "http://*.example", "", "file://host", "https://example.com/path", "https://user:pass@example.com"}) {
            assertThatThrownBy(() -> new WebSocketConfig(null, value)).isInstanceOf(IllegalArgumentException.class);
        }
        assertThatCode(() -> new WebSocketConfig(null, "http://localhost:8088,https://collaboard.example"))
                .doesNotThrowAnyException();
    }
    @Test void refusesWeakJwtKeysAndDoesNotPrintTokensInPrincipals() {
        assertThatThrownBy(() -> new JwtService("weak", "collaboard-auth")).isInstanceOf(IllegalStateException.class);
        assertThat(new ChatPrincipal("ana", "Ana", "token-que-no-debe-aparecer").toString())
                .doesNotContain("token-que-no-debe-aparecer");
    }
}
