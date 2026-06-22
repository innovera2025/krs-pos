import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/auth";
import { buildConnectionConfig } from "@/lib/krs/client";
import {
  getProductImportMapping,
  validateMapping,
  PRODUCT_IMPORT,
  PRODUCT_TARGET_FIELDS,
  type ProductImportMapping,
} from "@/lib/krs/mapping";
import { KrsMappingPatchBodySchema } from "@/lib/schemas/krsMapping";
import { parseBody } from "@/lib/schemas/_shared";
import { KrsKeyError } from "@/lib/krs/crypto";
import { runWithRequestId } from "@/lib/requestContext";
import { logger } from "@/lib/logger";

/**
 * KRS field-mapping API (krs-sync inbound import config, admin-only).
 *
 * Only the PRODUCT_IMPORT function is wired today; the route is shaped generically
 * (the `function` query/body field) so stock/customer/outbound functions can be
 * added later without a new endpoint.
 *
 *  GET   /api/krs/mappings?function=PRODUCT_IMPORT — requireAdmin. Returns the
 *        saved-or-default mapping for the function plus the target-field spec (so the
 *        UI knows which fields are required). Does NOT touch KRS (no connection).
 *
 *  PATCH /api/krs/mappings — requireAdmin. Zod-validates the body SHAPE/CHARSET
 *        (`function` literal, bounded `sourceTable`, `fieldMap` keys ⊆ known target
 *        fields, identifier-charset values), THEN performs a SECOND server-side gate:
 *        `validateMapping` confirms the `sourceTable` + every mapped column EXIST in
 *        the live KRS schema (via the existing parameterized introspection) before
 *        persisting — a 422 with a clear message otherwise. On success it upserts the
 *        singleton-per-function `KrsFieldMapping` row.
 *
 * ⚠️ requireAdmin is the REAL authorization boundary (defense-in-depth), not
 * middleware. All KRS driver errors stay sanitized server-side (validateMapping uses
 * the client helper which logs a sanitized error); only safe boundary messages cross.
 */

/** The target-field spec returned to the UI (which fields exist + are required). */
const TARGET_FIELDS_DTO = PRODUCT_TARGET_FIELDS.map((t) => ({
  field: t.field,
  required: t.required,
  label: t.label,
}));

/** Resolve the requested function from the query string. Only PRODUCT_IMPORT is
 *  wired; anything else (including absent) is rejected so the contract is explicit. */
function resolveFunction(req: Request): string | null {
  const url = new URL(req.url);
  return url.searchParams.get("function");
}

// GET /api/krs/mappings?function=PRODUCT_IMPORT — the saved-or-default mapping.
export async function GET(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireAdmin();
    if ("response" in gate) return gate.response;

    const fn = resolveFunction(req);
    if (fn !== PRODUCT_IMPORT) {
      return NextResponse.json(
        {
          error: "ฟังก์ชันไม่รองรับ · unsupported mapping function",
          code: "UNSUPPORTED_FUNCTION",
        },
        { status: 400 }
      );
    }

    try {
      const mapping = await getProductImportMapping();
      return NextResponse.json({
        function: mapping.function,
        sourceTable: mapping.sourceTable,
        fieldMap: mapping.fieldMap,
        targetFields: TARGET_FIELDS_DTO,
      });
    } catch (err) {
      logger.error({ err }, "GET /api/krs/mappings failed");
      return NextResponse.json(
        { error: "โหลดการจับคู่ฟิลด์ไม่สำเร็จ · could not load mapping", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}

// PATCH /api/krs/mappings — validate (shape + live schema) then upsert the singleton.
export async function PATCH(req: Request) {
  return runWithRequestId(req, async () => {
    const gate = await requireAdmin();
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

    // Gate 1: shape + charset bounds (the injection floor). function literal,
    // bounded sourceTable, fieldMap keys ⊆ known target fields, identifier values.
    const parsed = parseBody(KrsMappingPatchBodySchema, raw);
    if ("response" in parsed) return parsed.response;
    const data = parsed.data;

    // The candidate mapping we will validate + persist (typed from the parsed body).
    const candidate: ProductImportMapping = {
      function: PRODUCT_IMPORT,
      sourceTable: data.sourceTable,
      fieldMap: data.fieldMap,
    };

    // Gate 2: the mapping must reference REAL KRS objects. Build the connection
    // (null ⇒ not configured; KrsKeyError ⇒ server key missing) and validate the
    // sourceTable + every mapped column against the live introspection BEFORE persist.
    let config;
    try {
      config = await buildConnectionConfig();
    } catch (err) {
      if (err instanceof KrsKeyError) {
        logger.error({ err }, "PATCH /api/krs/mappings: KRS encryption key missing/invalid");
        return NextResponse.json(
          {
            error:
              "ยังไม่ได้ตั้งค่า KRS_CONFIG_ENC_KEY บนเซิร์ฟเวอร์ · server encryption key missing",
            code: "KRS_KEY_MISSING",
          },
          { status: 500 }
        );
      }
      logger.error({ err }, "PATCH /api/krs/mappings failed (config)");
      return NextResponse.json(
        { error: "บันทึกการจับคู่ฟิลด์ไม่สำเร็จ · could not save mapping", code: "INTERNAL" },
        { status: 500 }
      );
    }

    if (config === null) {
      // Cannot validate against a live schema without a connection. Reject so we
      // never persist an unvalidated mapping.
      return NextResponse.json(
        {
          error: "ยังไม่ได้ตั้งค่าการเชื่อมต่อ KRS · KRS connection not configured",
          code: "KRS_NOT_CONFIGURED",
        },
        { status: 422 }
      );
    }

    const validation = await validateMapping(config, candidate);
    if (!validation.ok) {
      // The mapping references a missing table/column (or a required field is
      // unmapped). 422 with the sanitized, non-sensitive message + a safe reason code.
      const status = validation.reason === "INTROSPECTION_FAILED" ? 502 : 422;
      return NextResponse.json(
        { error: validation.message, code: validation.reason },
        { status }
      );
    }

    // Persist the singleton-per-function row (validated).
    try {
      await prisma.krsFieldMapping.upsert({
        where: { function: PRODUCT_IMPORT },
        update: {
          sourceTable: candidate.sourceTable,
          fieldMap: candidate.fieldMap,
        },
        create: {
          function: PRODUCT_IMPORT,
          sourceTable: candidate.sourceTable,
          fieldMap: candidate.fieldMap,
        },
        select: { function: true },
      });

      logger.info(
        {
          krsMapping: {
            function: PRODUCT_IMPORT,
            sourceTable: candidate.sourceTable,
            fields: Object.keys(candidate.fieldMap),
          },
        },
        "KRS field mapping saved"
      );

      return NextResponse.json({
        function: candidate.function,
        sourceTable: candidate.sourceTable,
        fieldMap: candidate.fieldMap,
        targetFields: TARGET_FIELDS_DTO,
      });
    } catch (err) {
      // Postgres/Prisma error — cannot contain KRS secrets. Logged + generic message.
      logger.error({ err }, "PATCH /api/krs/mappings failed (persist)");
      return NextResponse.json(
        { error: "บันทึกการจับคู่ฟิลด์ไม่สำเร็จ · could not save mapping", code: "INTERNAL" },
        { status: 500 }
      );
    }
  });
}
