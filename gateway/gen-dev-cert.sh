#!/bin/sh
# Certificado TLS de DESARROLLO para el gateway (P3 · S1 Secure Channel).
#
# Crea una CA local y un certificado de servidor firmado por ella, solo si en el
# directorio no hay ya un server.crt/server.key (p. ej. uno real montado):
#   - CA "CollaBoard Dev CA" con nameConstraints: solo puede firmar localhost,
#     127.0.0.0/8, ::1 y los nombres de TLS_EXTRA_SAN. Su llave privada se BORRA
#     tras firmar: aunque el navegador confíe en ca.crt, nadie puede emitir con
#     ella certificados para otros dominios.
#   - Servidor ECDSA P-256, 397 días (límite que aceptan los navegadores).
#
# Corre solo al arrancar el contenedor (/docker-entrypoint.d/) y también a mano:
#   sh gateway/gen-dev-cert.sh [directorio]        (por defecto gateway/certs)
# Para confiar en el certificado, importa <directorio>/ca.crt en el navegador o
# en el sistema (ver README, sección HTTPS). Para regenerar, borra el directorio.
#
# TLS_EXTRA_SAN añade nombres al certificado, separados por coma, p. ej. la IP de
# la LAN para probar desde otra máquina: TLS_EXTRA_SAN=IP:192.168.1.35,DNS:sut.local
set -eu

dir="${1:-${TLS_CERT_DIR:-gateway/certs}}"
extra="${TLS_EXTRA_SAN:-}"

mkdir -p "$dir"
# Varios gateways pueden compartir el directorio (pruebas de contrato): el
# primero genera y los demás esperan a que termine.
lock="$dir/.gen.lock"
waited=0
until mkdir "$lock" 2>/dev/null; do
  waited=$((waited + 1))
  if [ "$waited" -gt 60 ]; then echo "gen-dev-cert: candado $lock ocupado; bórralo si quedó huérfano" >&2; exit 1; fi
  sleep 1
done
trap 'rmdir "$lock"' EXIT

if [ -s "$dir/server.crt" ] && [ -s "$dir/server.key" ]; then
  echo "gen-dev-cert: se usa el certificado existente en $dir"
  exit 0
fi

command -v openssl >/dev/null || { echo "gen-dev-cert: falta openssl" >&2; exit 1; }

san="DNS:localhost,IP:127.0.0.1,IP:::1"
permitted="permitted;DNS:localhost,permitted;IP:127.0.0.0/255.0.0.0,permitted;IP:0:0:0:0:0:0:0:1/FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF:FFFF"
old_ifs=$IFS
IFS=,
for entry in $extra; do
  case "$entry" in
    DNS:?*) san="$san,$entry"; permitted="$permitted,permitted;$entry" ;;
    IP:*.*.*.*) san="$san,$entry"; permitted="$permitted,permitted;$entry/255.255.255.255" ;;
    "") ;;
    *) echo "gen-dev-cert: TLS_EXTRA_SAN admite DNS:<nombre> o IP:<ipv4>, no '$entry'" >&2; exit 1 ;;
  esac
done
IFS=$old_ifs

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"; rmdir "$lock"' EXIT
umask 077

printf '%s\n' \
  "basicConstraints=critical,CA:TRUE,pathlen:0" \
  "keyUsage=critical,keyCertSign,cRLSign" \
  "nameConstraints=critical,$permitted" \
  "subjectKeyIdentifier=hash" > "$tmp/ca.ext"
printf '%s\n' \
  "basicConstraints=critical,CA:FALSE" \
  "keyUsage=critical,digitalSignature" \
  "extendedKeyUsage=serverAuth" \
  "subjectAltName=$san" \
  "authorityKeyIdentifier=keyid" > "$tmp/server.ext"

# Nombres por archivo y no con -subj "/O=...": Git Bash (Windows) convertiría
# ese argumento en una ruta.
dn() { printf '%s\n' "[req]" "prompt=no" "distinguished_name=dn" "[dn]" "O=CollaBoard" "CN=$1" > "$tmp/$2.cnf"; }
dn "CollaBoard Dev CA" ca
dn localhost server

openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/ca.key"
openssl req -new -key "$tmp/ca.key" -config "$tmp/ca.cnf" -out "$tmp/ca.csr"
openssl x509 -req -in "$tmp/ca.csr" -signkey "$tmp/ca.key" -days 825 -sha256 \
  -extfile "$tmp/ca.ext" -out "$tmp/ca.crt"

openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/server.key"
openssl req -new -key "$tmp/server.key" -config "$tmp/server.cnf" -out "$tmp/server.csr"
openssl x509 -req -in "$tmp/server.csr" -CA "$tmp/ca.crt" -CAkey "$tmp/ca.key" -CAcreateserial \
  -days 397 -sha256 -extfile "$tmp/server.ext" -out "$tmp/server.crt"

# La llave de la CA no sale de $tmp (se borra al salir). Se publica solo ca.crt.
cp "$tmp/server.key" "$dir/server.key"
cp "$tmp/server.crt" "$dir/server.crt"
cp "$tmp/ca.crt" "$dir/ca.crt"
chmod 600 "$dir/server.key"
chmod 644 "$dir/server.crt" "$dir/ca.crt"
echo "gen-dev-cert: certificado de desarrollo creado en $dir (SAN: $san); confía en $dir/ca.crt"
