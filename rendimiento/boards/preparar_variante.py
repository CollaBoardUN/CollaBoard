"""Genera el contexto descartable de la variante de pool desde el commit base."""

import hashlib
import json
import subprocess
from pathlib import Path


BENCH = Path(__file__).resolve().parent
ROOT = BENCH.parent.parent
CONTEXT = BENCH / ".local" / "variante-pool"
FILES = ("app/database.py", "app/routers/boards.py", "app/outbox.py")
ORIGINAL_IMAGE = "collaboard-perf_collaboration-api"


def git(*args):
    return subprocess.check_output(["git", "-c", f"safe.directory={ROOT.as_posix()}", *args], cwd=ROOT)


def replace_once(source, before, after):
    if source.count(before) != 1:
        raise ValueError("El código base cambió y requiere una revisión del parche.")
    return source.replace(before, after, 1)


def patches(database, boards, outbox):
    database = replace_once(
        database,
        "engine = create_engine(DATABASE_URL, connect_args=_connect_args)\n"
        "SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)",
        """_is_postgres = DATABASE_URL.startswith("postgresql")
_api_pool = {
    "pool_size": 25, "max_overflow": 25, "pool_timeout": 5.0, "pool_pre_ping": True,
} if _is_postgres else {}
engine = create_engine(DATABASE_URL, connect_args=_connect_args, **_api_pool)
SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

if _is_postgres:
    outbox_engine = create_engine(DATABASE_URL, pool_size=2, max_overflow=0, pool_timeout=5.0)
    OutboxSessionLocal = sessionmaker(bind=outbox_engine, autoflush=False, expire_on_commit=False)
else:
    OutboxSessionLocal = SessionLocal""",
    )
    boards = replace_once(boards, "    return [\n        BoardOut(\n", "    result = [\n        BoardOut(\n")
    boards = replace_once(
        boards,
        "        for b, role, n in rows\n    ]\n",
        "        for b, role, n in rows\n    ]\n"
        "    # Materializar primero, porque rollback expira los objetos ORM.\n"
        "    db.rollback()\n    return result\n",
    )
    outbox = replace_once(outbox, "from .database import SessionLocal", "from .database import OutboxSessionLocal")
    outbox = replace_once(outbox, "with SessionLocal() as db:", "with OutboxSessionLocal() as db:")
    return database, boards, outbox


def main():
    if git("branch", "--show-current").decode().strip() != "p3/performance":
        raise SystemExit("La variante requiere p3/performance.")
    revision = git("rev-parse", "HEAD").decode().strip()
    original = [git("show", f"{revision}:colaboracion-module/{name}") for name in FILES]
    adjusted = patches(*(source.decode("utf-8") for source in original))
    CONTEXT.mkdir(parents=True, exist_ok=True)
    dockerfile = [f"FROM {ORIGINAL_IMAGE}"]
    hashes = {}
    for name, before, after in zip(FILES, original, adjusted):
        destination = CONTEXT / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        data = after.encode("utf-8")
        destination.write_bytes(data)
        dockerfile.append(f"COPY {name} /app/{name}")
        hashes[name] = {"original_sha256": hashlib.sha256(before).hexdigest(),
                        "variant_sha256": hashlib.sha256(data).hexdigest()}
    (CONTEXT / "Dockerfile").write_text("\n".join(dockerfile) + "\n", encoding="utf-8")
    (CONTEXT / "fuentes.json").write_text(json.dumps({"revision": revision, "files": hashes}, indent=2) + "\n",
                                         encoding="utf-8")
    print(CONTEXT)


if __name__ == "__main__":
    main()
