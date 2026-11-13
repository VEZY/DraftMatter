#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 \
  --set app_password="$DM_DB_PASSWORD" --set identity_password="$KC_DB_PASSWORD" <<'SQL'
CREATE ROLE draftmatter LOGIN PASSWORD :'app_password';
CREATE ROLE keycloak LOGIN PASSWORD :'identity_password';
ALTER DATABASE draftmatter OWNER TO draftmatter;
CREATE DATABASE keycloak OWNER keycloak;
REVOKE CONNECT ON DATABASE draftmatter, keycloak FROM PUBLIC;
GRANT CONNECT ON DATABASE draftmatter TO draftmatter;
GRANT CONNECT ON DATABASE keycloak TO keycloak;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT ALL ON SCHEMA public TO draftmatter;
SQL
