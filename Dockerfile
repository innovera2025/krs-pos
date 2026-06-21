# syntax=docker/dockerfile:1

# ---- Base ----
FROM node:20-alpine AS base
WORKDIR /app
RUN apk add --no-cache libc6-compat openssl

# ---- Dependencies ----
FROM base AS deps
COPY package.json package-lock.json* ./
RUN npm ci

# ---- Build ----
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
# `next build` needs no runtime secrets: src/lib/env.ts skips its fail-fast during
# the build phase (NEXT_PHASE=phase-production-build), and the build runs no DB
# query. The runner stage below receives the REAL DATABASE_URL/AUTH_SECRET from the
# container env at runtime, where env.ts DOES fail-fast on a missing/invalid value.
RUN npm run build

# ---- Migrate (one-shot) ----
# Reuses the builder stage (full node_modules incl. the prisma CLI + the prisma/
# schema + migrations). Built only for the compose `migrate` service, which runs
# `prisma migrate deploy` once against the DB and exits. The app image below does
# NOT contain the prisma CLI.
FROM builder AS migrate
CMD ["npx", "prisma", "migrate", "deploy"]

# ---- Runner (production) ----
# Runs the Next.js standalone server. Copies only the traced server bundle + static
# assets + public dir (NOT the full node_modules) for a smaller image / faster cold
# start. The Prisma runtime client + native query engine are copied explicitly
# because standalone output tracing does not detect the engine binary.
FROM base AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

# Standalone server: minimal traced node_modules + server.js (next start replacement).
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
# Static assets are NOT included in the standalone bundle — copy them separately.
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
# CRITICAL: standalone tracing misses Prisma's generated client + native query
# engine (libquery_engine-*.so.node). Copy both so runtime queries work. The base
# stage already installed openssl + libc6-compat that the engine needs.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma/client ./node_modules/@prisma/client

USER nextjs
EXPOSE 3000
ENV PORT=3000 HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
