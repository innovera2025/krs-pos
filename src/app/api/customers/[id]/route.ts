import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { requireUser } from "@/lib/auth";
import {
  CustomerPatchBodySchema,
  CUSTOMER_PUBLIC_SELECT,
  classifyCustomerUniqueError,
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

    const touchesMembership = fields.isMember !== undefined;

    if (Object.keys(data).length === 0 && !touchesMembership) {
      return NextResponse.json(
        { error: "No fields to update", code: "NO_FIELDS" },
        { status: 400 }
      );
    }

    // Membership + member-key enforcement (loyalty program, Phase 1A). When the patch
    // touches membership OR the phone, read the current row so we can (a) stamp
    // `memberSince` only on the false→true enroll transition and (b) validate the
    // EFFECTIVE phone (the patch value if sent, else the stored value) — a member must
    // always keep a phone (the member key), so enrolling without a phone or clearing a
    // member's phone is rejected. Plain tax-only edits skip this read entirely.
    if (touchesMembership || fields.phone !== undefined) {
      const existing = await prisma.customer.findUnique({
        where: { id },
        select: { isMember: true, phone: true },
      });
      if (!existing) {
        return NextResponse.json(
          { error: "Customer not found", code: "NOT_FOUND" },
          { status: 404 }
        );
      }

      const nextIsMember = touchesMembership
        ? (fields.isMember as boolean)
        : existing.isMember;
      const nextPhone =
        fields.phone !== undefined ? fields.phone : existing.phone;

      if (nextIsMember && (nextPhone == null || nextPhone.length === 0)) {
        return NextResponse.json(
          { error: "สมาชิกต้องระบุเบอร์โทร", code: "MEMBER_PHONE_REQUIRED" },
          { status: 400 }
        );
      }

      if (touchesMembership) {
        data.isMember = fields.isMember as boolean;
        // Stamp memberSince on the false→true enroll transition only; an un-enroll
        // keeps the historical memberSince rather than clearing it.
        if (fields.isMember === true && existing.isMember === false) {
          data.memberSince = new Date();
        }
      }
    }

    try {
      const customer = await prisma.customer.update({
        where: { id },
        data,
        select: CUSTOMER_PUBLIC_SELECT,
      });
      return NextResponse.json(customer);
    } catch (err) {
      // Record-not-found (raced delete) → typed 404.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2025"
      ) {
        return NextResponse.json(
          { error: "Customer not found", code: "NOT_FOUND" },
          { status: 404 }
        );
      }
      // Two possible unique conflicts: the member-phone partial index (loyalty) or the
      // taxId unique — classify so the client gets a specific, actionable 409.
      const conflict = classifyCustomerUniqueError(err);
      if (conflict === "MEMBER_PHONE") {
        return NextResponse.json(
          { error: "เบอร์นี้มีสมาชิกใช้แล้ว", code: "MEMBER_PHONE_TAKEN" },
          { status: 409 }
        );
      }
      if (conflict === "TAXID") {
        return NextResponse.json(
          { error: "เลขผู้เสียภาษีนี้ถูกใช้งานแล้ว", code: "TAXID_TAKEN" },
          { status: 409 }
        );
      }
      logger.error({ err }, "PATCH /api/customers/[id] failed");
      return NextResponse.json(
        { error: "Could not update customer", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}
