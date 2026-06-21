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

# ---- Runner (production) ----
FROM base AS runner
ENV NODE_ENV=production
RUN addgroup --system --gid 1001 nodejs \
  && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/prisma ./prisma

USER nextjs
EXPOSE 3000
ENV PORT=3000
CMD ["npm", "run", "start"]
