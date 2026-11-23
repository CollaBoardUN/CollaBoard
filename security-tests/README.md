# security-tests · S2 Reverse Proxy

Pruebas del escenario S2 (gateway endurecido como punto único de entrada; ADR 0012). Las de S1 son
`s1_tls.py` y `s1_wireshark.py`.

| Archivo | Qué hace |
|---|---|
| [`s2_proxy.mjs`](s2_proxy.mjs) | Catálogo ejecutable: 41 ataques al borde y 5 controles. Imprime `OK`/`FAIL` por caso y termina con código 1 si alguno falla |
| [`s2_catalogo.md`](s2_catalogo.md) | El catálogo (petición exacta y resultado esperado) y la tabla «P2 → P3», generada desde las corridas |
| [`s2_tabla.mjs`](s2_tabla.mjs) | Genera esas tablas (y la de ZAP) desde los JSON de las corridas |
| [`s2_navegador.py`](s2_navegador.py) | Recorrido real en Chromium: violaciones de CSP, peticiones simultáneas, WebSocket abiertos, tasa pico y respuestas 429 |

## Reproducir (un comando)

Desde la raíz del repo, con el stack levantado (`cp .env.example .env && docker compose up -d --build --wait`):

```sh
node security-tests/s2_proxy.mjs --target https://localhost:8443 --ca gateway/certs/ca.crt
```

Requisitos: Node ≥ 22 y Docker. El script lee el access log del gateway (`docker compose logs`) para
comprobar `us=-`, captura el tramo interno con `nicolaka/netshoot:v0.13` (C03–C07) y lanza un contenedor
`python:3.12-slim` en la red `edge` para el lector lento (E05). Dura 64 s en las corridas de la evidencia
(más la descarga de esas dos imágenes la primera vez). Al final, la zona `web`
del gateway queda agotada unos segundos por la ráfaga de E04.

Opciones útiles: `--json <archivo>` guarda los resultados, `--only A01,C03` ejecuta solo esos casos y
`--help` lista el resto.

## Contra el P2 (evidencia del «antes»)

```sh
git worktree add ../p2-baseline 6af0456 && (cd ../p2-baseline && cp .env.example .env && docker compose up -d --build --wait)
node security-tests/s2_proxy.mjs --target http://localhost:8088 --pixels-ui http://localhost:3000/ \
     --compose-dir ../p2-baseline --json docs/p3/evidencia/S2/antes/s2_proxy-p2.json
node security-tests/s2_tabla.mjs --antes docs/p3/evidencia/S2/antes/s2_proxy-p2.json \
     --despues docs/p3/evidencia/S2/despues/s2_proxy-p3.json --escribir security-tests/s2_catalogo.md
```

## Recorrido en el navegador

```sh
pip install -r e2e/requirements.txt && python -m playwright install chromium
WEB_SSR_URL=https://localhost:8443 python security-tests/s2_navegador.py
```

## Resultados

P2 9/41 → P3 **41/41**; rechazos sin upstream (`us=-`) 15/28 → **28/28**. Evidencia completa en
[`docs/p3/evidencia/S2/`](../docs/p3/evidencia/S2/README.md).
