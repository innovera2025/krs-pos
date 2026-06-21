import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import {
  CustomerPatchBodySchema,
  CUSTOMER_PUBLIC_SELECT,
} from "@/lib/schemas/customer";
import { parseBody } from "@/lib/schemas/_shared";
// Phase 3 observability — request-id ALS context + structured logger (NODE-ONLY).
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

// The narrowed Customer projection (CUSTOMER_PUBLIC_SELECT) is imported from
// @/lib/schemas/customer so the edit returns the same CustomerDTO shape as
// GET/POST and the picker can swap the updated row in place without a refetch.

// PATCH /api/customers/[id] — edit a customer (Phase 4 tax-invoice 4c).
//
// AUTH (auth Phase 2): requireUser — mirrors GET/POST on /api/customers. A cashier
// can fix a customer's tax info mid-sale, so any authenticated active session is
// the correct gate (NOT admin).
//
// Validation: partial body via CustomerPatchBodySchema (same field rules as POST —
// 13-digit taxId, ≤200 name, ≤300 address, ≤30 phone, 5-digit buyerBranchCode).
// Only the provided keys are written. A duplicate taxId (P2002) → 409 TAXID_TAKEN;
// a missing row (P2025) → 404 NOT_FOUND.
export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  return runWithRequestId(req, async () => {
    const gate = await requireUser();
    if ("response" in gate) return gate.response;

    const { id } = params;
    if (typeof id !== "string" || id.length === 0) {
      return NextResponse.json(
        { error: "Missing customer id", code: "BAD_REQUEST" },
        { status: 400 }
      );
    }

    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body", code: "BAD_REQUEST" },
        { status: 400 }
      );
    }

    const parsed = parseBody(CustomerPatchBodySchema, raw);
    if ("response" in parsed) return parsed.response;
    const fields = parsed.data;

    // Build the update payload from ONLY the keys the client actually sent, so an
    // omitted field stays untouched (a cleared field arrives explicitly as null /
    // "00000" from the schema transforms). No body spread — explicit Prisma data.
    const data: Prisma.CustomerUpdateInput = {};
    if (fields.name !== undefined) data.name = fields.name;
    if (fields.taxId !== undefined) data.taxId = fields.taxId;
    if (fields.address !== undefined) data.address = fields.address;
    if (fields.phone !== undefined) data.phone = fields.phone;
    if (fields.buyerBranchCode !== undefined)
      data.buyerBranchCode = fields.buyerBranchCode;

    if (Object.keys(data).length === 0) {
      return NextResponse.json(
        { error: "No fields to update", code: "NO_FIELDS" },
        { status: 400 }
      );
    }

    try {
      const customer = await prisma.customer.update({
        where: { id },
        data,
        select: CUSTOMER_PUBLIC_SELECT,
      });
      return NextResponse.json(customer);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        // Record-not-found → typed 404.
        if (err.code === "P2025") {
          return NextResponse.json(
            { error: "Customer not found", code: "NOT_FOUND" },
            { status: 404 }
          );
        }
        // Unique-constraint on the only unique column (taxId) → typed 409.
        if (err.code === "P2002") {
          return NextResponse.json(
            { error: "เลขผู้เสียภาษีนี้ถูกใช้งานแล้ว", code: "TAXID_TAKEN" },
            { status: 409 }
          );
        }
      }
      logger.error({ err }, "PATCH /api/customers/[id] failed");
      return NextResponse.json(
        { error: "Could not update customer", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}
