#!/usr/bin/env bash
#
# Create or update the MySQL account AidaAdmin connects to its own store with.
# Idempotent: every run converges the grants, and a new password rotates it.
#
#   aida_admin_app   ALL PRIVILEGES on aida_admin_db (OAuth state, event
#                    receipts, audit), the database AidaAdmin owns.
#
# The account, password and database come from AIDA_ADMIN_DATABASE_URL, the
# same value the server connects with, decoded the same way (percent-encoded
# user and password). The read-only account for OfficePulse's aidacalls_db
# (OFFICEPULSE_RUNTIME_DATABASE_URL, aidaadmin_ro) belongs to OfficePulse,
# which owns that database; this script doesn't touch it.
#
# Run by an environment's operator with MySQL admin credentials, e.g. from a
# throwaway client on a network that reaches the database:
#
#   docker run --rm --network <network> -v "$PWD/scripts:/scripts:ro" \
#     -e AIDA_ADMIN_DATABASE_URL=… -e MYSQL_ADMIN_PASSWORD=… \
#     mysql:8.4 bash /scripts/db-users.sh
#
# DB_HOST overrides the URL's host when the operator reaches MySQL by another
# name. The account is created for any host ('%'): which networks can reach
# MySQL is the environment's decision, not something to pin here.

set -euo pipefail

URL="${AIDA_ADMIN_DATABASE_URL:?AIDA_ADMIN_DATABASE_URL: the mysql:// URL the server uses}"
ADMIN="${MYSQL_ADMIN_USER:-root}"
: "${MYSQL_ADMIN_PASSWORD:?MYSQL_ADMIN_PASSWORD: password for $ADMIN}"

die() { echo "[db-users] $*" >&2; exit 2; }
# Percent-decoding like decodeURIComponent: backslashes are protected first so
# printf %b only ever sees the \xNN it is given.
urldecode() { local s=${1//\\/\\\\}; printf '%b' "${s//%/\\x}"; }
# Names are interpolated into SQL, so they must be plain identifiers.
name() { [[ $1 =~ ^[A-Za-z0-9_]+$ ]] || die "not a plain identifier: $1"; printf '%s' "$1"; }
# A SQL string literal: backslashes and quotes escaped for the default sql_mode.
literal() { local s=${1//\\/\\\\}; printf "'%s'" "${s//\'/\'\'}"; }

re='^mysql://([^:@/]*)(:([^@/]*))?@([^:/?#]+)(:([0-9]+))?/([^/?#]+)'
[[ $URL =~ $re ]] || die "AIDA_ADMIN_DATABASE_URL must look like mysql://user:password@host[:port]/database"
USER_NAME=$(name "$(urldecode "${BASH_REMATCH[1]}")")
PASSWORD=$(urldecode "${BASH_REMATCH[3]}")
HOST="${DB_HOST:-${BASH_REMATCH[4]}}"
PORT="${BASH_REMATCH[6]:-3306}"
DB=$(name "${BASH_REMATCH[7]}")
[ -n "$PASSWORD" ] || die "AIDA_ADMIN_DATABASE_URL has no password"
who="'$USER_NAME'@'%'"
# In a database-level GRANT, _ and % are wildcards: escape them so the grant
# names exactly this database (aida\_admin\_db).
DB_GRANT=${DB//_/\\_}

# MYSQL_PWD keeps the admin password out of the process list; the SQL itself,
# including the account password, goes over stdin.
MYSQL_PWD="$MYSQL_ADMIN_PASSWORD" command mysql --protocol=TCP -h "$HOST" -P "$PORT" \
  -u "$ADMIN" --batch --skip-column-names <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB\`;
CREATE USER IF NOT EXISTS $who IDENTIFIED BY $(literal "$PASSWORD");
ALTER USER $who IDENTIFIED BY $(literal "$PASSWORD");
REVOKE ALL PRIVILEGES, GRANT OPTION FROM $who;
GRANT ALL PRIVILEGES ON \`$DB_GRANT\`.* TO $who;
SQL

echo "[db-users] $USER_NAME: ALL PRIVILEGES on $DB"
