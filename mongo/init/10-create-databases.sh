#!/bin/sh
# Se ejecuta SOLO la primera vez (volumen vacío), con el usuario root de MongoDB.
# Crea dos bases con credenciales separadas (mínimo privilegio):
#   collaboard_pixels -> usuario de Pixels   |   chat -> usuario de Chat
set -eu

mongosh --quiet -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin <<EOF
const pixels = db.getSiblingDB("collaboard_pixels");
pixels.createUser({ user: "${PIXELS_MONGO_USER}", pwd: "${PIXELS_MONGO_PASSWORD}", roles: [{ role: "readWrite", db: "collaboard_pixels" }] });

const chat = db.getSiblingDB("chat");
chat.createUser({ user: "${CHAT_MONGO_USER}", pwd: "${CHAT_MONGO_PASSWORD}", roles: [{ role: "readWrite", db: "chat" }] });
EOF
echo "mongo-init: bases collaboard_pixels y chat creadas con credenciales separadas"
