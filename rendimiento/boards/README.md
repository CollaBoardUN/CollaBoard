# CollaBoard P3 · Rendimiento de GET /api/boards

Responsable del experimento: Marlon David Pabón Muñoz · Arquitectura de Software · Universidad Nacional de Colombia.

## Escenario, alcance e hipótesis

Un usuario autenticado lista sus tableros activos mientras crece la carga concurrente. El estímulo se aplica al listener público del gateway en `https://gateway/api/boards`. Nginx termina TLS y reescribe la ruta a `/boards` en `collaboration-api`. La API valida el JWT, consulta la membresía y el estado de los tableros en `board-db`, y devuelve el arreglo JSON. El banco levanta los servicios integrados de P3. Durante la medición, la única carga de negocio inducida es el listado de tableros.

- **E1, seguridad con límites vigentes.** Si la tasa ofrecida por una IP supera la tasa sostenida admitida por el gateway, esperamos observar un aumento de los 429 y una reducción de la fracción de solicitudes admitidas. El experimento caracteriza la política del gateway bajo este patrón de tráfico.
- **E2, capacidad interna.** Si la concurrencia supera la capacidad de algún componente de la ruta, esperamos que el crecimiento de TPM exitosas se desacelere y que aumenten la latencia o los errores. CPU, RAM y estados de PostgreSQL permitirán contrastar hipótesis sobre el componente que se satura. Los 200 VUs del Laboratorio 6 orientan el barrido como punto operativo observado en otro entorno.

## Comparación con el Laboratorio 6

| Aspecto | Laboratorio 6 | Banco P3 |
|---|---|---|
| Estímulo y datos | GET por gateway HTTP con JWT obtenido fuera de la ventana. Una cuenta y diez tableros. | Gateway HTTPS con TLS verificado y JWT. Veinte cuentas de igual tamaño, con identidad y JSON validados antes y durante la medición. |
| Generador | k6 v2.4.0 en un portátil separado por wifi. VUs constantes con pausa de 1 s por iteración. | k6 v0.54.0 en la red perimetral Docker. E1 controla tasa de llegada. E2 controla VUs sin pausa, así que los VUs de ambos estudios no representan la misma presión. |
| Niveles y repetición | 1, 10, 50, 100, 150, 200, 300, 500, 1000 y 2000 VUs. Ventanas de 30 s, calentamiento común de 10 VUs durante 10 s, pausas de 20 s y una curva, con dos observaciones a 200 VUs. | Calentamiento al nivel medido, ventanas de 90 s, tres repeticiones válidas y refinamiento local. La escalada superior se condiciona al margen del generador y del sistema. |
| Infraestructura | Ryzen 7 5800X, 16 GB y Docker Desktop en el SUT. Tres contenedores con 1 CPU cada uno. Memoria de 512 MiB para Nginx y Colaboración y 1 GiB para PostgreSQL. | Reproduce los cupos de los tres contenedores mediante valores numéricos de Compose. Registra CPU y RAM disponibles para todo Docker. El generador y ambos proyectos Docker comparten el host, por lo que hay que controlar la interferencia antes de inferir capacidad. |
| Métricas y evidencia | Latencia promedio, p95 y máximo, errores HTTP y req/s. Docker cada 2 s y Postgres cada 1 s. Tablas por nivel y por versión, serie de conexiones retenidas, barras comparativas a 200 VUs y tres paneles alineados de latencia, throughput y CPU. | TPM ofrecidas y exitosas, p50/p95/p99 de éxitos y 429, errores por categoría y muestras cada ~5 s. CSV por corrida y por nivel con dispersión entre repeticiones y series UTC de recursos. Para el informe, graficar p95/p99, TPM exitosas y ofrecidas, 429/errores y CPU por nivel. Usar series de Postgres para los episodios anómalos. |
| Rodilla, óptimo y límite | El texto llamó rodilla al primer punto con ≥95 % del máximo observado, corroborado por latencia y CPU. El máximo de la curva fue 172,67 req/s a 1000 VUs (≈10 360 TPM, 0 % de errores). A 200 VUs hubo 167,29 req/s (≈10 037 TPM) y 445,1 ms de p95. A 2000 VUs hubo 158,28 req/s (≈9497 TPM) y 12 558,5 ms de p95. | Conforme a la aclaración del profesor, 200 VUs es el punto óptimo observado en el laboratorio. En P3 se estiman por separado el óptimo operativo, el intervalo de rodilla y el límite práctico. El 95 % del máximo observado queda como comprobación retrospectiva si se confirma un techo. |

El Laboratorio 6 reprodujo el bloqueo original a 200 VUs, con 15 conexiones `idle in transaction`, ninguna consulta activa durante el episodio y un error de espera del pool de 30 s. La hipótesis de inanición de hilos era consistente con la evidencia. La corrección del laboratorio dimensionó el pool a 25+25, separó el de outbox y devolvió la conexión tras materializar la respuesta. La primera variante hacía rollback antes de materializar y generó refrescos N+1. La versión final pasó a estar limitada por CPU de Colaboración, cerca de un núcleo desde 300 VUs. En la rama P3, el engine principal conserva 5+10 por defecto, el outbox usa la misma fábrica de sesiones y el listado termina sin ese rollback explícito. La posible recurrencia del bloqueo se investigará correlacionando tiempos, estados de Postgres, CPU y logs del servicio experimental. Informe del Laboratorio 6 (referencia metodológica interna, no anexada al repositorio) · [Pool de P3](../../colaboracion-module/app/database.py) · [Outbox](../../colaboracion-module/app/outbox.py) · [Listado](../../colaboracion-module/app/routers/boards.py)

## Auditoría del código y configuración

| Hallazgo | Evidencia y consecuencia para el diseño |
|---|---|
| Proceso Uvicorn y pool de Colaboración | El Dockerfile ejecuta un Uvicorn sin `--workers` y el Compose no fija `WEB_CONCURRENCY`. `create_engine` usa los valores predeterminados de SQLAlchemy para PostgreSQL: 5 conexiones persistentes y hasta 10 adicionales por engine. El listado usa una sesión por petición y una consulta con joins y agregación de miembros. Conservar esta configuración y contrastarla en la medición. [Dockerfile](../../colaboracion-module/Dockerfile) · [Sesiones](../../colaboracion-module/app/database.py) · [Endpoint](../../colaboracion-module/app/routers/boards.py) · [SQLAlchemy](https://docs.sqlalchemy.org/en/20/core/pooling.html#sqlalchemy.pool.QueuePool) |
| Límites y segmentación | El listener TLS aplica listas blancas de Host, ruta y método. Los límites usan la IP que Nginx observa. `/api/boards` comparte la zona API, con 30 req/s y burst 60 sin demora por defecto, y hereda el límite de 60 peticiones simultáneas por IP. Ambos mecanismos pueden devolver 429. `edge` comunica k6 con el gateway. El tráfico upstream pasa por `app` y Colaboración alcanza Postgres solo por `net-board`. [Compose raíz](../../docker-compose.yml) · [Rutas API](../../gateway/templates/snippets/api-routes.conf.template) · [Límites por IP](../../gateway/templates/snippets/hardening.conf.template) |
| Compatibilidad de overlays | `config --quiet` en Compose v2.2.3 devolvió código 15 para TLS, RBAC y Pixels por `cpus: "1.0"` (se esperaba `float32`) y para el banco de Notificaciones por la red `internal` indefinida de `k6-notifications`. El overlay **de integración** de Notificaciones usa `app`, `net-notif` y `net-mq` y sí se usa en este banco. [TLS](../tls/compose.override.yml) · [RBAC](../rbac/compose.override.yml) · [Pixels](../pixels/compose.override.yml) · [Banco de notificaciones](../notificaciones/compose.override.yml) · [Integración](../../notifications-module/compose.gateway.yml) |
| Entorno anterior | El `.env` local observado define el origen público por HTTP y desactiva la cookie segura. El runner pasa su propio archivo con `--env-file` y neutraliza las variables de interpolación heredadas durante la ejecución. |

## Aislamiento, TLS y datos

El runner combina el Compose raíz, el overlay de integración de Notificaciones y [el override de boards](compose.override.yml). Compose 2.2.3 normaliza el modelo a JSON. El runner quita los dos puertos publicados del gateway, vuelve a validar ese modelo y lo usa con `-p collaboard-perf`. El control verifica nombres de volúmenes y redes, montajes de solo lectura, ausencia de puertos publicados y red exclusiva `edge` para k6. Antes del arranque, inventaría contenedores, redes y volúmenes por nombre y etiqueta. Si existe un recurso sin la etiqueta vinculada a `.local/owner-id`, el runner aborta antes de reutilizarlo. Conservar ese identificador junto con el entorno generado. Ejecutar el overlay directamente con `docker compose up` omite estos controles.

| Parámetro del listener público | E1 | E2 |
|---|---:|---:|
| Zona API | 30 req/s | 100 000 req/s |
| Ráfaga API | 60 | 100 000 |
| Peticiones simultáneas por IP | 60 | 10 000 |
| Zona de autenticación y ráfaga | 5 req/s, 10 | 5 req/s, 10 |

Se conservan las plantillas, TLS, el saneado de cabeceras, JWT, rutas, roles, políticas y segmentación de P3. El ajuste E2 de conexiones también rige para las rutas públicas que heredan ese límite. El gateway genera un certificado con SAN `DNS:gateway` y almacena la clave y la CA en el volumen experimental `collaboard-perf_boards_tls`. El runner extrae únicamente la CA pública. k6 la lee desde un montaje de solo lectura mediante `SSL_CERT_FILE` y verifica cadena y hostname. El banco no requiere instalar la CA en Windows.

`Prepare` y `Pilot` crean credenciales sintéticas aleatorias en `.local/perf.env` a partir del ejemplo y conservan ese archivo para los volúmenes experimentales asociados. La siembra usa registro, login, creación y listado por HTTPS. Crea 20 usuarios de `example.invalid` y 10 tableros privados por usuario con datos deterministas. Completa una siembra parcial al repetir `Prepare` con el mismo archivo. Cada corrida abre nuevas sesiones en el preflight, verifica que una petición anónima devuelva 401 y valida la identidad y el catálogo de cada usuario. k6 rota entre las 20 cuentas. Cada HTTP 200 se cuenta como éxito solo si el tipo de contenido y el JSON contienen los 10 tableros esperados, sus IDs, propietario, rol, número de miembros y fechas válidas.

Los JWT viven en memoria de k6. La salida de k6 incluye únicamente métricas agregadas. Mantener `.local/` fuera de la evidencia y evitar volcar el modelo Compose efectivo o activar depuración de HTTP. Los volúmenes experimentales y su archivo de entorno se conservan entre repeticiones.

## Diseño y protocolo de campaña

| Fase | E1 | E2 |
|---|---|---|
| Piloto de integración | Una comprobación posterior del limitador con 40 y 60 req/s, si se autoriza | Primer piloto de 1 VU, 10 s de calentamiento y 20 s de medición |
| Barrido inicial de la campaña | 20, 30, 40 y 60 req/s | 1, 2, 4, 8, 16, 32 y 64 VUs sobre P3 original, con una ventana exploratoria de 30 s |
| Extensión condicional | Se activa si queda una transición por confirmar | Si el primer barrido no revela transición y hay margen, explorar 128 y 256 VUs. Los niveles superiores requieren justificación y verificación del entorno. Por encima de 400 se exige `-AllowHighLoad`. |
| Refinamiento | Pasos de 2 req/s si hace falta ubicar el inicio reproducible de 429 | Insertar niveles intermedios, con resolución de 1 VU si la transición está cerca del inicio. Usar tres réplicas formales de 90 s en niveles críticos y vecinos. |

1. Ejecutar niveles como corridas independientes. Usar 30 s de calentamiento al mismo nivel de carga, una separación de 12 s para drenar peticiones y 90 s de medición estable. En E1 esa separación permite recuperar el burst antes de la ventana medida. Repetir tres veces por nivel. Esperar al menos 60 s entre corridas y comprobar que CPU y conexiones se acercan a la línea base antes de continuar. Completar cada réplica del barrido con un orden registrado, alternando el sentido cuando toda la banda sea segura.
2. E1 usa llegada abierta (`constant-arrival-rate`) con 200 VUs preasignados, una petición por iteración y sin reintentos. Cada corrida sale de una sola IP. E2 usa carga cerrada (`constant-vus`), una petición a la vez por VU, sin pausa entre iteraciones ni reintentos. La latencia del sistema determina el ritmo efectivo. Los niveles E1 y E2 corresponden a unidades diferentes. [Ejecutor de tasa constante](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/)
3. Conservar versión, CPU y RAM de Docker, revisión Git, imagen k6, huella de la CA, nivel, ventana y repetición. Registrar también las imágenes efectivas del despliegue, estado de otros procesos en el host, estado inicial del ambiente, orden y observaciones. Cuando `collaboard` esté activo en el mismo Docker Engine, documentar su carga como factor de confusión y repetir si cambia sustancialmente. Usar el mismo equipo y configuración entre puntos comparados.
4. Suspender la escalada si aparecen reinicios, OOM o ≥20 % de fallos distintos de 429 en una corrida. En E2 cualquier 429 exige revisar el perfil. Antes de ampliar por encima de 400 VUs, comprobar en los datos del nivel anterior que k6 no perdió iteraciones, que al host le queda margen de CPU y RAM para el salto, que el SUT se recupera tras el enfriamiento y que el proyecto principal se mantiene estable. Documentar la decisión y repetir el control en cada salto, incluso por encima de 1000 VUs. Si el entorno impide continuar, informar el mayor nivel válido y el bloqueo observado.

### Métricas y aceptación

- `TPM exitosas = éxitos × 60 / segundos medidos`. Las TPM ofrecidas cuentan peticiones iniciadas. Los descartes del planificador se registran por separado. Contabilizar las solicitudes iniciadas en la ventana medida, aunque terminen durante el drenaje posterior. El timeout del cliente es 10 s, frente a los 60 s del laboratorio. Esta diferencia puede convertir en timeouts las esperas largas del laboratorio. Ante episodios de 10 s, usar también los estados y logs del SUT para investigar la causa.
- Latencia de extremo a extremo p50, p95 y p99 en ms, medida hasta recibir el cuerpo. Publicar percentiles de éxitos y de 429 por separado. Registrar conteos de 429, 401/403, otros 4xx, 5xx, HTTP inesperado, JSON inválido, timeout, otros fallos de transporte e iteraciones interrumpidas. Expresar el porcentaje de fallos sobre las peticiones iniciadas.
- Telemetría cada ~5 s por contenedor, con CPU de Docker, RAM usada y porcentaje de memoria. Un 100 % de CPU equivale aproximadamente a un núcleo. Muestrear `pg_stat_activity` en la base experimental de tableros con conexiones totales, activas, inactivas, inactivas en transacción y activas con espera. El observador excluye su propia sesión. Registrar `max_connections` para contextualizar las muestras del servidor. Los sockets observados en PostgreSQL no miden la cola para adquirir conexiones en SQLAlchemy.
- **Piloto apto:** al menos un listado medido, todos correctos, cero descartes y telemetría disponible. Verificar en el análisis el recorte de la ventana y la presencia de muestras de gateway, Colaboración, Postgres y k6. Aplicar los objetivos de calidad a la campaña con tres repeticiones.
- **Corrida válida:** sin descartes de k6 ni interrupciones, sin fallos de autenticación o contrato y con ≥70 % de las muestras esperadas dentro de la ventana por recurso clave y Postgres. En E1 la programación observada debe quedar dentro de ±2 % del objetivo. En E2 se exige cero 429. Registrar si k6 o el host se saturan. Una corrida limitada por el generador requiere revalidar el entorno antes de usarla para inferir capacidad.
- **Objetivo operativo propuesto:** p95 ≤500 ms, p99 ≤1000 ms y ≤1 % de fallos totales en las tres repeticiones válidas. En E1 los 429 cuentan en este objetivo y siguen siendo evidencia del funcionamiento del limitador. Los umbrales son parte del protocolo propuesto y no son resultados del Laboratorio 6.

### Interpretación de la curva

| Punto | Regla de lectura |
|---|---|
| Óptimo operativo | Mayor nivel medido que cumple el objetivo en todas las repeticiones y queda al menos 20 % por debajo de la cota inferior de la rodilla confirmada, cuando exista. Reportar carga, TPM y margen. Si falta evidencia de la rodilla, presentar un punto operativo provisional. |
| Rodilla | Primer intervalo refinado donde la mediana de p95 aumenta al menos 50 % y la pendiente incremental de TPM exitosas por unidad de carga cae al 50 % o menos de la del tramo anterior con pendiente positiva. Confirmar la tendencia en el nivel siguiente y revisar rangos de réplica y telemetría. Reportar el intervalo y su incertidumbre. En E1, identificar si corresponde al limitador usando 429 y, si se requiere, los eventos de Nginx del gateway experimental. |
| Límite práctico de capacidad | Intervalo desde el último nivel previo a una meseta confirmada, con ≤5 % de ganancia de TPM a lo largo de dos incrementos y deterioro de latencia o errores, o hasta el primer nivel con caída sostenida de TPM o fallo reproducible. Declarar los máximos exitosos observados si el barrido termina antes de confirmar este límite. Interpretar el alcance del límite de E1 por IP y el de E2 para el despliegue evaluado. |

El informe debe incluir el escenario, control de variables, tabla por repetición, mediana y rango por nivel, curva de TPM ofrecidas y exitosas, percentiles y errores, series de recursos, interpretación de los tres puntos y amenazas a la validez. La red local de Docker, el mismo host para generador y sistema, una IP de salida, 20 cuentas, un único patrón de consulta, cachés calientes y la ausencia de carga de fondo inducida en otros servicios acotan la generalización.

## Comandos de ejecución

Ejecutar desde la raíz con Windows PowerShell 5.1+, Docker Engine con contenedores Linux y Docker Compose v2.2.3. Docker requiere acceso a imágenes y dependencias de build si faltan en caché. k6 corre como contenedor. Solo el análisis requiere Python 3.9+ con biblioteca estándar. Si la terminal ya permite ejecutar scripts locales, se puede invocar `.ps1` directamente. Los comandos siguientes aplican la política únicamente al proceso de PowerShell que lanzan.

```powershell
# Solo validacion estatica del modelo. No consulta el motor Docker.
powershell -NoProfile -ExecutionPolicy Bypass -File .\rendimiento\boards\run.ps1 -Action Config -Experiment E1
powershell -NoProfile -ExecutionPolicy Bypass -File .\rendimiento\boards\run.ps1 -Action Config -Experiment E2

# Repetir el piloto de integracion. Prepara el proyecto y ejecuta 1 VU.
powershell -NoProfile -ExecutionPolicy Bypass -File .\rendimiento\boards\run.ps1 -Action Pilot
```

Una vez autorizado el barrido, `Prepare` construye y siembra sin medir. Cada `Run` aplica el perfil del punto al proyecto experimental y usa las imágenes ya construidas. Por ejemplo, un punto E1 y uno E2, cada uno con ID de repetición 1:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\rendimiento\boards\run.ps1 -Action Prepare -Experiment E1
powershell -NoProfile -ExecutionPolicy Bypass -File .\rendimiento\boards\run.ps1 -Action Run -Experiment E1 -Level 30 -Repetition 1
powershell -NoProfile -ExecutionPolicy Bypass -File .\rendimiento\boards\run.ps1 -Action Run -Experiment E2 -Level 100 -Repetition 1
python .\rendimiento\boards\analizar.py .\rendimiento\boards\resultados
```

Cada corrida genera `meta.json`, `k6.json`, `recursos.csv` y `postgres.csv` bajo `resultados/`. El analizador alinea telemetría con el tiempo UTC de inicio del escenario, produce `corridas.csv`, `niveles.csv`, `recursos_resumen.csv` e `incidencias.csv`, y conserva las corridas inválidas para inspección. Las estadísticas entre repeticiones son medianas y rangos de estadísticas por corrida. El piloto queda fuera del agregado por nivel. Revisar sincronía del reloj de Windows y de la VM Docker si la cobertura temporal es baja.

`campana.py` orquesta invocaciones de `run.ps1` sin cambiar los servicios. Enfría 60 s entre puntos y comprueba el estado de `collaboard` y la memoria disponible del motor durante la carga. Antes de cada punto formal verifica recuperación con CPU de Colaboración <15 % y hasta una conexión activa o retenida. Detiene la escalada ante invalidación o 20 % de fallos distintos de 429. Si detecta riesgo durante una corrida, solo puede detener k6 con las etiquetas del proyecto y del banco. Las ventanas exploratorias y formales se agregan por separado.

```powershell
python -B .\rendimiento\boards\campana.py E2 1 2 4 8 16 32 64 --seconds 30
python -B .\rendimiento\boards\campana.py E1 20 30 40 60 --repetitions 1 2 3
```

### Variante experimental de pool

`preparar_variante.py` lee las tres fuentes de Colaboración desde el commit actual de `p3/performance`. Escribe un contexto aislado en `.local/variante-pool/`, con el Dockerfile y el manifiesto SHA-256. La imagen derivada `collaboard-perf_collaboration-api:pool-lab6` hereda la imagen original y solo reemplaza esos archivos. Antes de construir, comprobar que las fuentes del contenedor original coinciden con los hashes del manifiesto tras normalizar CRLF.

La variante de PostgreSQL usa pool API 25+25, timeout 5 s y `pool_pre_ping`. El despachador de outbox tiene pool propio 2+0 con timeout 5 s. El registro y el encolado de eventos conservan la transacción original. El listado materializa todos los `BoardOut` antes de `rollback()`. SQLite usa la fábrica de sesiones original para que la regresión pruebe el mismo archivo local. `regresion_variante.py` incluye pruebas de JWT, privacidad, conteo SQL, liberación y entrega del outbox.

```powershell
python -B .\rendimiento\boards\preparar_variante.py
docker build --pull=false -t collaboard-perf_collaboration-api:pool-lab6 .\rendimiento\boards\.local\variante-pool
powershell -NoProfile -ExecutionPolicy Bypass -File .\rendimiento\boards\run.ps1 -Action Configure -Experiment E2 -Variant Pool
powershell -NoProfile -ExecutionPolicy Bypass -File .\rendimiento\boards\run.ps1 -Action Configure -Experiment E2 -Variant Original
```

`Configure` cambia solo la configuración del proyecto experimental y espera su salud sin medir. Aplicar la variante después de las regresiones aisladas. Para medirla, usar `campana.py E2 NIVEL --variant Pool` con las mismas ventanas y calentamiento del control. La opción predeterminada es `Original`. El agrupamiento separa ambas imágenes. `comparacion-variante.csv` empareja únicamente niveles con iguales controles e imágenes de los otros servicios.

En la extensión exploratoria del pool ajustado se usaron ventanas de 40 s para conservar la comparabilidad con el par a 32 VUs. Los niveles autorizados fueron 48, 64, 100, 150 y 200 VUs. `--stop-error-pct 1` detiene la escalada al alcanzar 1 % de fallos distintos de 429 y `--stop-p99-ms 8000` conserva margen frente al timeout de 10 s. Son reglas de escalada adicionales. Un nivel se puede medir válidamente y quedar fuera del objetivo operativo por latencia sin registrar fallos.

Las tablas abreviadas `tabla-variante-corridas.csv` y `tabla-variante-niveles.csv` conservan los identificadores de corrida y cohorte. Los puntos exploratorios de 40 s quedan separados de las réplicas de 90 s. Para el gráfico del cruce del objetivo, usar `--latency-range MIN MAX` con la cohorte que tenga tres corridas válidas por nivel.

### Evidencia para el informe académico

| Sección del informe | Evidencia del banco |
|---|---|
| Entorno y orden | `meta.json` registra inicio UTC, revisión Git, huellas del banco, imágenes efectivas, Docker/Compose/k6, cgroup, recursos de Docker y límites efectivos. Incluye CPU, RAM y SO de Windows cuando estén disponibles, y estado observado de `collaboard` antes y después (IDs, estado, hora de arranque y reinicios). `corridas.csv` incluye orden cronológico y fase. |
| Tablas 1–4 | `niveles.csv` agrega medianas y rangos de TPM, latencias de éxitos y 429, porcentaje de 429 y otros fallos, CPU, RAM y conexiones. La columna `comparable` exige tres repeticiones válidas distintas. `cohort` evita mezclar recursos, imágenes, código o configuración distintos. |
| Tabla 5 y sección 6.4 | `k6.json` exporta la media aritmética de las muestras exitosas y `corridas.csv` la conserva como `success_mean_ms`. `comprobaciones.csv` calcula por réplica E2 válida con cero fallos (X=N/R), (R=N/X), concurrencia de extremo a extremo y demanda de CPU (U/X). La concurrencia de Colaboración usa los tiempos del backend solo si se correlacionaron todos los éxitos; no usa la latencia del cliente como sustituto. |
| Figuras 1–5 | `figuras/` incluye PNG de 200 ppp y SVG. El despliegue representa la ruta medida del modelo de Compose. E1 compara TPM y 429 con la referencia teórica. E2 muestra percentiles, TPM, CPU, RAM y errores. El refinamiento usa niveles marcados con `-Phase Refinement` o cotas explícitas. PostgreSQL toma las muestras de las corridas indicadas. |
| Diagnóstico e incidencias | `gateway.csv` contiene estado, upstream, duración en ms, ID de correlación y clase de evento. `collaboration-api.csv` contiene estado, duración del handler y avisos de `QueuePool` con tamaño, overflow y timeout. `incidencias.csv` recoge corridas incompletas, inválidas y fallos de captura. |
| Directivas y transporte | `meta.json` guarda las directivas seleccionadas de `nginx -T`. `k6.json` cuenta respuestas por protocolo HTTP y solicitudes con establecimiento TCP o handshake TLS observados, e indica si k6 permite reutilización. Los contadores de tiempos describen eventos observados; no equivalen a un inventario de sockets. |

Los eventos con ID pertenecen al recorrido medido, incluidos los que aparecen durante el drenaje. Los avisos de Nginx y del pool sin ID se identifican por ventana y clase. Si una corrida formal registra timeouts, 5xx o fallos de transporte, se deja un margen de hasta 35 s desde el final de la ventana para capturar errores tardíos del servidor. La exportación conserva campos permitidos y descarta texto arbitrario, cabeceras, IPs, consultas y cuerpos. La rotación de Docker puede reducir la cobertura. Comparar `gateway_access_count` y `collab_ok_correlated_count` con los conteos de k6 antes de interpretar los logs.

Para las figuras, instalar Matplotlib si falta. El análisis CSV funciona con `--no-plots` usando solo la biblioteca estándar.

```powershell
python .\rendimiento\boards\analizar.py .\rendimiento\boards\resultados
```

Para generar la ampliación y la comparación temporal de PostgreSQL, pasar `--refinement MIN MAX` y repetir `--pg-run ID` para cada corrida elegida. Los identificadores se toman de `corridas.csv`. Las anotaciones `--knee MIN MAX`, `--optimum VU` y `--limit VU` se aplican únicamente al perfil E2 que las sustenta. El analizador exige niveles con tres repeticiones válidas y el criterio académico se confirma revisando las curvas y la telemetría. La integración de los resultados con el Laboratorio 6 queda en `resultados/INTEGRACION.md`.

## Piloto ejecutado y estado de la campaña

Compose 2.2.3 validó los modelos E1 y E2, incluso con valores conflictivos de proyecto, tasa, cookie y origen en la terminal. Se comprobó la sintaxis de PowerShell 5.1, los módulos JS y Python. Las comprobaciones con datos sintéticos cubrieron la clasificación de respuestas, el resumen sin tokens, el cálculo de TPM, el recorte temporal de la telemetría y el agregado de repeticiones.

El piloto `E2-1-r1-2129171f69a7` pasó con Docker Engine 20.10.12, Compose v2.2.3 y k6 0.54.0. La VM de Docker tenía 16 CPU lógicas y 7,44 GiB de RAM. Docker confirmó cuotas efectivas de 1 CPU y 512 MiB para gateway y Colaboración, y 1 CPU y 1 GiB para Postgres. Se verificó la siembra de 20 cuentas con 10 tableros privados cada una. El preflight comprobó HTTP 401 sin JWT y catálogos válidos con JWT sobre HTTPS. Una comprobación adicional con OpenSSL negoció TLS 1.3 y verificó la cadena y el nombre `gateway`.

| Métrica | Piloto de 1 VU |
|---|---:|
| Calentamiento y medición | 10 s y 20 s |
| Listados HTTP 200 con JSON correcto | 2090 de 2090 |
| TPM exitosas | 6270 |
| Latencia p50 / p95 / p99 | 8 / 13 / 49 ms |
| Fallos, 429 y descartes | 0 |
| Postgres | 3 muestras, hasta 2 conexiones totales, 1 activa y 1 inactiva en transacción |

Las cuatro muestras por contenedor cubrieron gateway, Colaboración, Postgres y k6. Los picos observados de CPU y RAM fueron, respectivamente, 12,28 % y 38,67 MiB, 77,79 % y 70,68 MiB, 21,50 % y 27,58 MiB, y 19,86 % y 14,45 MiB. Las TPM son la normalización de los 20 s medidos. La evidencia local está en `resultados/E2-1-r1-2129171f69a7/`, con las tablas derivadas bajo `resultados/`.

El resumen histórico del piloto conserva percentiles y carece de las observaciones individuales y la media. `success_mean_ms` queda vacío para esa corrida. Tampoco se retrocompletan contadores de transporte ni logs correlacionados introducidos después.

El primer arranque se interrumpió antes de generar carga porque Nginx rechazó 100 000 conexiones simultáneas por IP. Se ajustó ese parámetro E2 a 10 000 y se mantuvo la tasa elevada. Compose 2.2.3 había dejado las cuotas de CPU en cero con `cpus: 1.0`. El banco pasó a usar `cpu_period` y `cpu_quota`, verifica las cuotas efectivas antes de medir y espera la salud de los servicios con un plazo definido. El inventario del motor inspeccionado estaba libre de recursos `collaboard-perf` antes del primer arranque. Se conservaron los volúmenes creados por el propio banco para el reintento. La inspección final confirmó redes y volúmenes Docker distintos entre ambos proyectos, incluido el volumen anónimo que MongoDB monta en `/data/configdb`. Los 16 contenedores de `collaboard` conservaron ID, marca de arranque y contador de reinicios en la comparación antes y después del piloto.

Los resultados de las campañas E1 y E2, sus límites de interpretación y la comparación con la variante experimental se documentan en `resultados/INTEGRACION.md`. Las ventanas breves y las repeticiones formales quedan en cohortes separadas para reproducir las tablas y figuras de cada fase.
