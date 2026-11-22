# S2 · Reverse Proxy — evidencia

- [`antes/`](antes/README.md): el P2 (`6af0456`) atacado con el catálogo, más ZAP baseline.
- [`despues/`](despues/README.md): el P3 (rama `p3/s2-proxy`) con el mismo catálogo y el mismo ZAP, las
  pruebas de que la aplicación sigue funcionando y la verificación desde un clon limpio.
- Catálogo y tabla por caso «P2 → P3»: [`security-tests/s2_catalogo.md`](../../../../security-tests/s2_catalogo.md).

## Medida del escenario

| Medida (escenario S2) | P2 | P3 |
|---|---|---|
| Ataques del catálogo bloqueados o normalizados | 9 / 41 | **41 / 41** |
| Rechazos sin upstream, verificados con `us=-` en el access log | 15 / 28 | **28 / 28** |
| Cabeceras que revelan versión o stack (y cabeceras de los servicios) | 1 (`Server: nginx/1.31.9`) | **0** (queda `Server: nginx`, sin versión) |
| Puertos del stack accesibles desde el host, salvo gateway y consola de RabbitMQ en loopback | 1 (`3000`) | **0** |
| Tráfico legítimo afectado (controles, E2E, smoke, `ws_check`, navegador) | — | 0 fallos, 0 respuestas 429 |

## ZAP baseline P2 → P3

Mismas banderas (`-m 5 -j`), misma red (`edge` del proyecto) y mismo servicio (`gateway`); solo cambia
el target (`http://gateway:80` → `https://gateway:443`). Cobertura: 25 URL en ambas corridas.

<!-- s2:zap:inicio -->
<!-- Generado por: node security-tests/s2_tabla.mjs --zap-antes docs/p3/evidencia/S2/antes/zap_p2.json --zap-despues docs/p3/evidencia/S2/despues/zap_p3.json. No editar a mano. -->

| Regla ZAP | Alerta | P2 (http://gateway:80) | P3 (https://gateway:443) |
|---|---|---|---|
| 10019 | Content-Type Header Missing | Informational (Medium) ×1 | Informational (Medium) ×1 |
| 10038 | Content Security Policy (CSP) Header Not Set | Medium (High) ×1 | — |
| 10049 | Non-Storable Content | Informational (Medium) ×1 | Informational (Medium) ×1 |
| 10055 | CSP: script-src unsafe-inline | — | Medium (High) ×1 |
| 10055 | CSP: style-src unsafe-inline | — | Medium (High) ×1 |
| 10202 | Absence of Anti-CSRF Tokens | Medium (Low) ×1 | Medium (Low) ×1 |
| 90004 | Cross-Origin-Embedder-Policy Header Missing or Invalid | Low (Medium) ×1 | Low (Medium) ×1 |
| 90004 | Cross-Origin-Resource-Policy Header Missing or Invalid | Low (Medium) ×1 | — |

<!-- s2:zap:fin -->

Lectura: desaparecen «CSP Header Not Set» (Medium) y «Cross-Origin-Resource-Policy» (Low); aparecen
«CSP: script-src unsafe-inline» y «CSP: style-src unsafe-inline» (Medium), que son el riesgo residual
declarado de la CSP (Next.js con SSR hidrata con scripts y estilos en línea; quitarlos exige nonces en
web-ssr). El número de alertas Medium pasa de 2 a 3: ZAP pasa de «no hay CSP» a «hay CSP con
`unsafe-inline`». «Absence of Anti-CSRF Tokens» se mantiene: ZAP busca un token en los formularios de
`/login` y `/register`, que usan Server Actions de Next (con comprobación de `Origin`); la protección CSRF
del BFF es `Origin` + `x-collaboard-client` (`web-ssr/src/server/bffPolicy.ts`). COEP no se añade (ver ADR 0012).
