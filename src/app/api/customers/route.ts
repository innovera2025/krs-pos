import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";

// This route reads request searchParams, so it is inherently dynamic. Declaring it
// explicitly silences the benign DYNAMIC_SERVER_USAGE build log (the route is
// already rendered on-demand `ƒ`; no behavior change).
export const dynamic = "force-dynamic";

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
  const gate = await requireUser();
  if ("response" in gate) return gate.response;

  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") ?? "").trim();

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
      select: {
        id: true,
        name: true,
        taxId: true,
        phone: true,
        address: true,
        branchId: true,
      },
      orderBy: { name: "asc" },
      take: 200,
    });
    return NextResponse.json(customers);
  } catch (err) {
    console.error("GET /api/customers failed:", err);
    return NextResponse.json(
      { error: "Could not load customers", code: "INTERNAL" },
      { status: 500 }
    );
  }
}
