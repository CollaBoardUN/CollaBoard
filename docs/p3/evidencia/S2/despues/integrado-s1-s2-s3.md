# S2 sobre la rama integrada (S1 + S2 + S3)

Verificación de S2 después de rebasar `p3/s2-proxy` sobre `p3/s1+s3` (`c59f8c6`, con S1 y S3). Mismo
script y mismos comandos que en [`../README.md`](../README.md), con el stack levantado desde cero
(`docker compose down -v` y `up -d --build --wait`): 16 servicios en marcha, 13 con healthcheck `healthy`
(`message-worker`, `notification-api` y `pixels-ui` no tienen healthcheck, como en el P2).

| Comprobación | Resultado |
|---|---|
| `s2_proxy.mjs`: ataques bloqueados o normalizados | **41/41** |
| `s2_proxy.mjs`: controles | **5/5** |
| `s2_proxy.mjs`: rechazos con `us=-` en el log | **28/28** |
| F06, puertos publicados por el stack | solo `gateway 8088→80` y `8443→443` (la consola de RabbitMQ ya no se publica: S3) |
| Contrato del gateway (`gateway/tests/contract.test.mjs`) | 120/120 |
| `gateway_smoke.sh` y `ws_check.mjs` | todas las comprobaciones OK |
| S1 (`s1_tls.py`) | todas las comprobaciones OK |
| S3 (`s3_segmentacion.py`) | permitidos 22/22 · bloqueados datos/broker 45/45 · worker→app 8/8 · sin Internet 14/14 |
| E2E (`test_web_ssr.py`, `test_notifications.py`) | 4/4 en 6 de 7 corridas; ver nota |
| `s2_navegador.py` | 0 violaciones de CSP bloqueantes, 0 errores de JS, 0 respuestas 429; 11 peticiones simultáneas como máximo; pico de 19 peticiones/s en la zona `web` |

Resultados completos del catálogo: [`s2_proxy-p3-integrado.json`](s2_proxy-p3-integrado.json).

**Nota sobre el E2E.** En la primera corrida tras levantar el stack, `test_recorrido_web_completo` falló
(`AssertionError` de un localizador); las 6 corridas siguientes pasaron 4/4, incluida una hecha
justo después del catálogo completo y otra después de la ráfaga E04, sin ningún 429 en el log del gateway
en esas ventanas. No se identificó la causa; queda registrada como una falla no reproducida, sin atribuirla
a S2.
