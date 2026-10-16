#!/bin/bash -l
set -euo pipefail

[[ "${INSTANCE_TYPE:-}" == "production" ]] || exit 0
[[ "${INSTANCE_NUMBER:-}" == "0" ]] || exit 0

cd "${APP_HOME:?Répertoire applicatif absent}"
: "${DATABASE_URL:?Connexion privée non chargée}"
export ADMIN_OPERATOR=clever-cron
exec npm run db:purge -- --expired
