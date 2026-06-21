import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import {
  CustomerPostBodySchema,
  CUSTOMER_PUBLIC_SELECT,
} from "@/lib/schemas/customer";
import { parseBody } from "@/lib/schemas/_shared";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

// This route reads request searchParams, so it is inherently dynamic. Declaring it
// explicitly silences the benign DYNAMIC_SERVER_USAGE build log (the route is
// already rendered on-demand `ƒ`; no behavior change).
export const dynamic = "force-dynamic";

// The narrowed Customer projection (CUSTOMER_PUBLIC_SELECT) now lives in
// @/lib/schemas/customer so GET/POST/PATCH all return the identical CustomerDTO
// shape from a single source of truth.

// GET /api/customers — list customers for the POS customer picker (Phase 6a).
//
// Optional query filter:
//   ?q=<text> — case-insensitive substring match on name OR taxId.
//
// The picker only SELECTS existing (seeded) customers — there is intentionally
// NO POST/add-customer in 6a (customer CRUD is out of scope). The select is
// narrowed to the fields the picker + tax-invoice header need.
//
// AUTH (auth Phase 2): requireUser — the customer picker is used at POS checkout
// by cashiers, so any authenticated active session is the correct gate (NOT
// admin); the response carries Customer PII so it must not be anonymous.
export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;

    try {
      const { searchParams } = new URL(req.url);
      // Length cap (theme #3): silently truncate the search term to 200 chars so an
      // arbitrarily long ILIKE pattern is never sent to Postgres. Silent truncation
      // (not a 400) is the friendlier convention for a free-text search field.
      const q = (searchParams.get("q") ?? "").trim().slice(0, 200);

      const where: Prisma.CustomerWhereInput = q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { taxId: { contains: q, mode: "insensitive" } },
            ],
          }
        : {};

      const customers = await prisma.customer.findMany({
        where,
        select: CUSTOMER_PUBLIC_SELECT,
        orderBy: { name: "asc" },
        take: 200,
      });
      return NextResponse.json(customers);
    } catch (err) {
      logger.error({ err }, "GET /api/customers failed");
      return NextResponse.json(
        { error: "Could not load customers", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

// POST /api/customers — create a customer (Phase 4 tax-invoice 4c).
//
// AUTH (auth Phase 2): requireUser — mirrors GET. A cashier adds a tax customer
// mid-sale at /pos checkout, so any authenticated active session is the correct
// gate (NOT admin); the body carries Customer PII so it must not be anonymous.
//
// Validation (theme #3): the body is validated by CustomerPostBodySchema at the
// parse boundary — required name (≤ 200), optional 13-digit `taxId` (the §86/4
// buyer-TIN format), optional address (≤ 300) / phone (≤ 30), and a 5-digit
// `buyerBranchCode` defaulting to "00000". A duplicate taxId (P2002) maps to a
// typed 409 TAXID_TAKEN instead of a raw 500.
export async function POST(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", code: "BAD_REQUEST" },
        { status: 400 }
      );
    }

    const parsed = parseBody(CustomerPostBodySchema, raw);
    if ("response" in parsed) return parsed.response;
    const { name, taxId, address, phone, buyerBranchCode } = parsed.data;

    try {
      // Explicit Prisma data (no body spread) — only the validated/narrowed fields
      // reach the DB; `branchId` keeps its schema default (BR-01).
      const customer = await prisma.customer.create({
        data: { name, taxId, address, phone, buyerBranchCode },
        select: CUSTOMER_PUBLIC_SELECT,
      });
      return NextResponse.json(customer, { status: 201 });
    } catch (err) {
      // Unique-constraint on the only unique column (taxId) → typed 409.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        return NextResponse.json(
          { error: "เลขผู้เสียภาษีนี้ถูกใช้งานแล้ว", code: "TAXID_TAKEN" },
          { status: 409 }
        );
      }
      logger.error({ err }, "POST /api/customers failed");
      return NextResponse.json(
        { error: "Could not create customer", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}
