---
description: Manual smoke-test of the POS flow (requires Docker + a database)
argument-hint: (no args)
allowed-tools: Bash(docker compose up -d db), Bash(npm run prisma:generate), Bash(npm run db:push), Bash(npm run prisma:seed)
---
Run a manual smoke test of the full POS flow. **A database is required.** Run the steps in order and
stop + report on the first failure.

1. Ensure a `.env` exists (copy from `.env.example`) with `DATABASE_URL`, `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` set. (Phase 0 moved these out of `docker-compose.yml`.)
2. Start Postgres:      `docker compose up -d db`
3. Generate client:     `npm run prisma:generate`
4. Push schema:         `npm run db:push`
5. Seed sample data:    `npm run prisma:seed`
6. Start dev server:    `npm run dev`  → open http://localhost:3000
7. Exercise the flow: search a product → add to cart → adjust qty → กด**ชำระเงิน** → confirm a bill number appears. Also check `GET /api/products` and `GET /api/orders` respond (and that `/api/orders` does NOT return any `password` field).

Notes:
- The `db` service **no longer publishes port 5432** to the host (Phase 0). When the app runs inside compose it reaches the DB at host `db`; if you run the app on the host you must make the DB reachable (run the app inside compose, or temporarily publish the port).
- Report which steps passed and paste any failure output. Do not seed/push against a database that holds real data.
