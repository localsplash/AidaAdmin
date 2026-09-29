#!/usr/bin/env bash
# Provision AidaAdmin's own store from its canonical app=aida-admin DB_* rows.
# AidaPlatformDB runs this with the same DB_USER/DB_PASSWORD the app reads.
# OfficePulse provisions the separate app=aida-admin-runtime read-only account.
# MYSQL_ADMIN_HOST/PORT may override the operator's network path, never app settings.
set +x
set -euo pipefail

die() { printf '[db-users] %s\n' "$*" >&2; exit 2; }
identifier() { [[ $1 =~ ^[A-Za-z0-9_]+$ && ${#1} -le $3 ]] || die "$2 must be a plain identifier (max $3 characters)"; }
literal() { local value=${1//\\/\\\\}; printf "'%s'" "${value//\'/\'\'}"; }

: "${DB_HOST:?DB_HOST is required}"
: "${DB_NAME:?DB_NAME is required}"
: "${DB_USER:?DB_USER is required}"
: "${DB_PASSWORD:?DB_PASSWORD is required}"
ADMIN=${MYSQL_ADMIN_USER:-root}
: "${MYSQL_ADMIN_PASSWORD:?MYSQL_ADMIN_PASSWORD is required}"
HOST=${MYSQL_ADMIN_HOST:-$DB_HOST}
PORT=${MYSQL_ADMIN_PORT:-${DB_PORT:-3306}}
identifier "$DB_NAME" DB_NAME 64
[[ $DB_NAME == aida_admin_db ]] || die 'DB_NAME must be the dedicated aida_admin_db database'
identifier "$DB_USER" DB_USER 32
identifier "$ADMIN" MYSQL_ADMIN_USER 32
[[ $DB_USER != "$ADMIN" && $DB_USER != root ]] || die 'Application and admin accounts must be distinct'
[[ $PORT =~ ^[0-9]{1,5}$ ]] && (( 10#$PORT >= 1 && 10#$PORT <= 65535 )) || die 'MySQL port must be 1-65535'
ACCOUNT="'$DB_USER'@'%'"
# Database-level GRANT treats underscores as wildcards unless escaped.
GRANT_DATABASE=${DB_NAME//_/\\_}

if ! MYSQL_PWD="$MYSQL_ADMIN_PASSWORD" command mysql --protocol=TCP \
  --host="$HOST" --port="$PORT" --user="$ADMIN" --connect-timeout=10 \
  --default-character-set=utf8mb4 --binary-mode --batch --skip-column-names \
  >/dev/null 2>&1 <<SQL
SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION';
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS $ACCOUNT IDENTIFIED BY $(literal "$DB_PASSWORD");
ALTER USER $ACCOUNT IDENTIFIED BY $(literal "$DB_PASSWORD");
REVOKE ALL PRIVILEGES, GRANT OPTION FROM $ACCOUNT;
GRANT ALL PRIVILEGES ON \`$GRANT_DATABASE\`.* TO $ACCOUNT;
SQL
then die 'MySQL provisioning failed; check connectivity/admin privileges and rerun.'
fi
printf '[db-users] %s: ALL PRIVILEGES on %s\n' "$DB_USER" "$DB_NAME"
