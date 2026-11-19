# Verificación independiente desde un clon limpio
Fecha: 2026-11-19T23:29:56Z
$ git clone --branch p3/s2-proxy <repo> colaboard-clon   # commit 1258f75
$ cd colaboard-clon && cp .env.example .env && docker compose up -d --build --wait
  -> exit 0; 13 servicios healthy y 3 sin healthcheck (message-worker, notification-api, pixels-ui); gateway/certs se creó al arrancar.
  -> puertos publicados: gateway 0.0.0.0:8088->80 y 0.0.0.0:8443->443; rabbitmq 127.0.0.1:15672.
$ node security-tests/s2_proxy.mjs --target https://localhost:8443 --ca gateway/certs/ca.crt
Ataques bloqueados o normalizados: 41/41 · controles: 5/5 · rechazos con us=- en el log: 28/28
  -> veredictos idénticos a docs/p3/evidencia/S2/despues/s2_proxy-p3.json en los 46 casos.
$ docker compose -f gateway/tests/compose.test.yml up -d --build --wait && node --test gateway/tests/contract.test.mjs
# tests 120
# pass 120
# fail 0
