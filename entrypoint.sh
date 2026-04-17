#!/bin/sh
set -e

# commukit stores its tables in a dedicated schema (set via the
# `?schema=commukit` query parameter on DATABASE_URL). The schema
# must exist before `prisma migrate deploy` runs — Prisma does not
# auto-create schemas. Safe to run every boot; the IF NOT EXISTS
# makes it idempotent.
echo "Ensuring commukit schema exists..."
echo "CREATE SCHEMA IF NOT EXISTS commukit;" \
  | npx prisma db execute --schema=prisma/schema.prisma --stdin

echo "Running Prisma migrations..."
npx prisma migrate deploy

echo "Starting Communications Service..."
exec node dist/main
