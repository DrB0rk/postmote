#!/bin/sh
set -eu
command -v docker >/dev/null
command -v openssl >/dev/null
work=$(mktemp -d "${TMPDIR:-/tmp}/postmote-mail-test.XXXXXX")
container=''
cleanup() {
  if [ -n "$container" ]; then docker rm -f "$container" >/dev/null 2>&1 || :; fi
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$work/key.pem" -out "$work/cert.pem" -days 1 -subj '/CN=localhost' -addext 'subjectAltName=IP:127.0.0.1,DNS:localhost' >/dev/null 2>&1
openssl pkcs12 -export -inkey "$work/key.pem" -in "$work/cert.pem" -out "$work/server.p12" -name greenmail -passout pass:changeit >/dev/null 2>&1
chmod 644 "$work/server.p12"
container=$(docker run -d --rm -p 127.0.0.1::3993 -p 127.0.0.1::3465 -p 127.0.0.1::3143 -p 127.0.0.1::3025 -v "$work/server.p12:/home/greenmail/greenmail.p12:ro" -e 'GREENMAIL_OPTS=-Dgreenmail.setup.test.imaps -Dgreenmail.setup.test.smtps -Dgreenmail.setup.test.imap -Dgreenmail.setup.test.smtp -Dgreenmail.hostname=0.0.0.0 -Dgreenmail.users=berk:test-password@berkderooij.nl,agent:test-password@example.test -Dgreenmail.users.login=email -Dgreenmail.tls.keystore.file=/home/greenmail/greenmail.p12 -Dgreenmail.tls.keystore.password=changeit' greenmail/standalone@sha256:309ba544ea482e5d4265d09921cdab07c8dad2cc4481d715c9b8ff5d3f0a149f)
imap_port=$(docker port "$container" 3993/tcp | sed 's/.*://')
smtp_port=$(docker port "$container" 3465/tcp | sed 's/.*://')
imap_starttls_port=$(docker port "$container" 3143/tcp | sed 's/.*://')
smtp_starttls_port=$(docker port "$container" 3025/tcp | sed 's/.*://')
POSTMOTE_TEST_CERT="$work/cert.pem" POSTMOTE_TEST_PRIVATE_KEY="$work/key.pem" POSTMOTE_TEST_IMAP_STARTTLS_PORT="$imap_starttls_port" POSTMOTE_TEST_SMTP_STARTTLS_PORT="$smtp_starttls_port" POSTMOTE_TEST_IMAP_PORT="$imap_port" POSTMOTE_TEST_SMTP_PORT="$smtp_port" NODE_EXTRA_CA_CERTS="$work/cert.pem" bun test tests/mail-integration.test.ts tests/crash-integration.test.ts
