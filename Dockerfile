FROM node:25-alpine AS builder

# OpenSSL 3 is required by Prisma's query/schema engine on Alpine.
# Without it Prisma defaults to the non-existent openssl-1.1.x path
# and the engine fails to start at runtime.
RUN apk add --no-cache openssl

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY prisma ./prisma
RUN npx prisma generate

COPY . .
RUN npm run build

# ── Production ──────────────────────────────────────────────────────────────
FROM node:25-alpine

# OpenSSL 3 — see builder-stage comment. Prisma's query engine links
# against it at runtime.
RUN apk add --no-cache openssl

WORKDIR /app

# Create the non-root runtime user BEFORE copying files so --chown works.
RUN addgroup -g 1001 appgroup && adduser -u 1001 -G appgroup -s /bin/sh -D appuser

# Copy artifacts with ownership set directly. Critical for node_modules
# because `prisma migrate deploy` at container start writes engine
# binaries under /app/node_modules/@prisma/engines — that directory has
# to be writable by appuser.
COPY --from=builder --chown=appuser:appgroup /app/dist ./dist
COPY --from=builder --chown=appuser:appgroup /app/node_modules ./node_modules
COPY --from=builder --chown=appuser:appgroup /app/prisma ./prisma
COPY --from=builder --chown=appuser:appgroup /app/package*.json ./
COPY --chown=appuser:appgroup entrypoint.sh ./entrypoint.sh
COPY --chown=appuser:appgroup LICENSE /app/LICENSE
COPY --chown=appuser:appgroup NOTICE /app/NOTICE

RUN chmod +x ./entrypoint.sh

USER appuser

EXPOSE 3014

ENTRYPOINT ["./entrypoint.sh"]
