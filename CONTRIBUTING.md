# Cómo contribuir

## Flujo de trabajo

1. Crea una rama desde `main` con tu módulo y el cambio: `canvas/herramienta-texto`, `realtime/presencia`, `tableros/fix-invitaciones`.
2. Haz commits pequeños con mensajes claros en presente: `Agrega endpoint de elementos`.
3. Abre un Pull Request hacia `main`. La plantilla trae un checklist.
4. La CI debe pasar y otra persona del equipo revisa antes de fusionar.

`main` siempre debe funcionar: no se sube directo a `main`.

## Antes de abrir un PR

```bash
# Backend
cd backend
ruff check . && ruff format .
pytest

# Frontend
cd frontend
npm run lint && npm run typecheck && npm test
```

## Cambios en la base de datos

Nunca se modifican tablas a mano. Se cambia el modelo y se genera una migración:

```bash
cd backend
alembic revision --autogenerate -m "describe el cambio"
# revisa el archivo generado en migrations/versions/
alembic upgrade head
```

## Cambios en la API

Si agregas o cambias un endpoint, actualiza `docs/API.md` y los tipos en `frontend/src/lib/types.ts`.
