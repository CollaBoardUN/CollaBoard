#!/usr/bin/env python3
"""Genera una configuración gateway basada en el archivo REAL del equipo.
No sobrescribe web-ssr/dev/gateway/nginx.conf ni modifica rutas ajenas.
"""
from pathlib import Path
import sys
root = Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else Path.cwd()
source = root / 'web-ssr/dev/gateway/nginx.conf'
output = root / 'notifications-module/gateway.notifications.conf'
if not source.exists():
    raise SystemExit('Falta web-ssr/dev/gateway/nginx.conf: usa la rama Tiempo_real-y-chat')
text = source.read_text(encoding='utf-8')
needle = 'server dev-mocks:4100;'
if text.count(needle) != 1:
    raise SystemExit(f'Se esperaban 1 upstream de notificaciones (se encontraron {text.count(needle)}); revisar manualmente.')
text = text.replace(needle, 'server notification-api:4100;')
if 'location /api/notifications' not in text:
    raise SystemExit('No se encontró ruta de notificaciones; confirmar contrato de gateway')
output.write_text(text, encoding='utf-8')
print(f'Generada {output.relative_to(root)} con upstream real C#, sin cambios a otros módulos.')
