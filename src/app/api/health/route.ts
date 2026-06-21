import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// Always evaluated at request time — a health probe must hit the live DB, never a
// build-time prerender or a cached response.
export const dynamic = "force-dynamic";

// GET /api/health — liveness + DB-readiness probe (production-readiness Phase 1,
// theme #6).
//
// PUBLIC (no requireUser): a load balancer / uptime monitor / docker healthcheck
// must reach it unauthenticated, and an attacker learns nothing useful from
// "db: ok". The middleware matcher only gates the (shell) nav prefixes, so this
// non-nav API path is already allowed through.
//
// Runs a cheap `SELECT 1` to verify the Prisma connection pool can actually reach
// Postgres (a process can be "up" but unable to serve any real request if the DB is
// down). Returns 200 { status: "ok", db: "ok" } when reachable, else 503
// { status: "error", db: "unreachable" } so orchestration can tell a healthy app
// from a booted-but-broken one.
export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json(
      { status: "ok", db: "ok", timestamp: new Date().toISOString() },
      { status: 200 }
    );
  } catch (err) {
    console.error("GET /api/health failed:", err);
    return NextResponse.json(
      { status: "error", db: "unreachable", timestamp: new Date().toISOString() },
      { status: 503 }
    );
  }
}
