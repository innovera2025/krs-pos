# KRS POS — Security & Best-Practice Gap Audit

- วันที่: 2026-06-20
- วิธีการ: multi-agent workflow (7 มิติ ขนาน) → adversarial verification รายมิติ → completeness critic ข้ามมิติ. ทุกช่องว่างอ้างอิง `file:line` จากซอร์สจริง
- ผลรวม (หลังตรวจสอบ): **100 ช่องว่างที่ยืนยันแล้ว** — 🔴 critical 18 · 🟠 high 39 · 🟡 medium 32 · ⚪ low 11. **ไม่มีข้อใดถูกตัดเป็น false-positive**
- ขอบเขต: Next.js 14 (App Router) + Prisma + PostgreSQL POS ที่จัดการเงินและสต็อกจริง

> สรุปบรรทัดเดียว: โปรเจกต์อยู่ในระดับ **prototype** — มี happy-path ที่ทำงานได้ แต่ยัง **ขาดรากฐานทั้งหมดที่ทำให้ระบบรับเงินจริงได้อย่างปลอดภัยและถูกต้อง**: ไม่มี auth, ไม่มี input validation, การคำนวณเงินไม่แม่นยำ, สต็อกติดลบได้, ไม่มี test/CI, build แตก, และไม่มี audit trail

---

## 8 ปัญหารากเหง้า (root themes)

### 1. 🔴 ไม่มี Authentication / Authorization เลย — *ปัญหาที่ร้ายแรงที่สุด*
ทุก API route เปิดให้ทุกคนเรียกแบบไม่ระบุตัวตน (`src/app/api/orders/route.ts`, `products/route.ts` ไม่มี auth check, ไม่มี `middleware.ts`)
- ใครที่เข้าถึง server ได้ (LAN/เน็ต) → สร้างบิลปลอม, แก้ราคาสินค้า (ตั้ง ฿1000 เป็น ฿1), ดูดยอดขายทั้งหมดได้
- **รหัสผ่านเก็บเป็น plaintext** (`prisma/seed.ts:49`) และ **publish credential จริงไว้ใน README** (`admin@krs-pos.local / admin123`)
- **`GET /api/orders` รั่วรหัสผ่านแคชเชียร์ให้คนนอก** (include `cashier: true` ทั้ง User) — เส้นทาง full-compromise ที่เร็วที่สุด
- `Role` enum มีแต่ไม่เคยถูกบังคับใช้ (RBAC = 0) · `cashierId` รับจาก body ปลอมได้ · ไม่มี session/logout/expiry · ไม่มี rate limit · (อนาคต) ไม่มี CSRF
- **แก้:** Auth.js v5 หรือ Lucia (httpOnly cookie) + `middleware.ts` + RBAC `requireRole()` + hash ด้วย argon2id/bcrypt + ดึง `cashierId` จาก session + select เฉพาะ field ปลอดภัย

### 2. 🔴 ความถูกต้องของเงินและสต็อก (Financial / Inventory Integrity) — *หัวใจของ POS*
- **คำนวณเงินด้วย JS float** ไม่ใช่ Decimal end-to-end → ยอดเพี้ยนระดับสตางค์ สะสมจนปิดลิ้นชักไม่ลง (`orders/route.ts:49,60-62`)
- **สต็อกติดลบได้** — decrement โดยไม่เช็คว่าพอ + race condition (สองเครื่องขายชิ้นสุดท้ายพร้อมกัน) (`orders/route.ts:84-89`)
- **ไม่มี idempotency** — กดซ้ำ/เน็ตกระตุก = บิลซ้ำ + ตัดสต็อกซ้ำ
- **เชื่อตัวเลขจาก client** — ส่ง `discount = subtotal` ได้ของฟรี, `taxRate`/`amountPaid` ปลอมได้ → ฉ้อโกง + ภาษีผิด
- `amountPaid < total` ผ่านเงียบ ๆ (และ UI จ่าย subtotal ไม่รวม tax → ขาดทุกบิล)
- `orderNumber = Date.now()` ชนกันใต้ concurrency → checkout ล้ม
- **ไม่มี refund/void flow** (enum REFUNDED/CANCELLED ลอย) · **ไม่มี audit trail** · ไม่มี DB CHECK constraints · line items ไม่ reconcile กับ header
- **แก้:** Decimal/integer-satang ทั้งสาย + service layer (`lib/pricing.ts`) + server recompute + atomic conditional decrement (`updateMany where stock gte`) + CHECK constraints + Serializable tx + idempotency key + orderNumber จาก DB sequence + append-only audit log

### 3. 🟠 ไม่มี Input Validation
ไม่มี Zod/Valibot — body ผ่าน raw type assertion + `as never` → NaN totals, negative quantity (เพิ่มสต็อก!), mass assignment, malformed body = 500
- **แก้:** Zod schema ที่ทุก route boundary, `safeParse` → 400, สร้าง Prisma `data` แบบ explicit (ไม่ spread body), แชร์ schema client+server

### 4. 🟠 ไม่มี Error Handling / Observability
- ไม่มี try/catch ในทุก route → exception กลายเป็น raw 500 (P2002 ซ้ำ SKU, product ไม่เจอ, DB หลุด)
- ไม่มี logging เลย (0 บรรทัด) · ไม่มี monitoring (Sentry) · ไม่มี correlation/request ID · ไม่มี React `error.tsx` boundary · ไม่มี `/api/health`
- **transaction rollback แบบเงียบ** — แคชเชียร์รับเงินสดแล้ว tx timeout, ไม่มี log ผูกกับบิล → ปิดร้านแล้วเงินเกินไม่รู้สาเหตุ
- **แก้:** `withErrorHandler` + typed `{error, code}` 4xx · pino structured logs + business events · Sentry · `x-request-id` middleware · `error.tsx` · health endpoint

### 5. 🟠 ไม่มี Testing / CI / Quality Gates
- **0 test, ไม่มี runner** · ไม่มี CI · `next lint` ตั้งไม่เสร็จ (ไม่มี eslint config/dep) · **ไม่มี lockfile** (npm ci ใช้ไม่ได้) · ไม่มี coverage · ไม่มี pre-commit · ไม่มี test-DB seam
- **แก้:** Vitest (แยก `lib/pricing.ts` ทดสอบ money math) + Testcontainers/pglite สำหรับ route tests + Playwright e2e (1-2 happy path) + coverage threshold สูงบน module เงิน/สต็อก + GitHub Actions CI (typecheck/lint/test/build/`docker build`/gitleaks) + husky + commit lockfile

### 6. 🟠 Build / Deploy / Secrets แตก
- **Docker build ล้ม 2 จุด:** `COPY public/` (ไม่มีโฟลเดอร์) + `npm ci` (ไม่มี lockfile)
- **DB password hardcode ใน docker-compose** + ใช้ **superuser `postgres`** + **publish port 5432** → ใครใน LAN เข้า DB ตรงได้
- ใช้ `db push` (ไม่มี migration history) · ไม่มี DB bootstrap ตอน deploy แรก · ไม่มี healthcheck · ไม่มี env validation ตอน boot · ไม่มี standalone output (image อ้วน) · ไม่มี resource limits
- **แก้:** `public/.gitkeep` + commit lockfile · secrets → git-ignored `.env`/Docker secrets · ไม่ publish 5432 · least-priv DB role · `prisma migrate deploy` ตอน startup · `/api/health` + compose healthcheck · `output: "standalone"` · env module (Zod) fail-fast

### 7. 🟡 สถาปัตยกรรม / Code Best Practices
- business logic อยู่ใน route handler (ไม่มี service/domain layer) → money math ทดสอบ/reuse ไม่ได้, refund flow จะเขียนซ้ำเพี้ยน
- type ฝั่ง client เขียนมือซ้ำ+เพี้ยนจาก Prisma (`price: number` ทั้งที่ wire เป็น Decimal string)
- ไม่มี shared pricing module · ไม่มี DTO/response typing (รั่ว field) · ไม่มี money serialization contract · fetch ไม่มี AbortController/typed error
- **แก้:** `src/services/checkout.ts` (pure, testable) · derive types จาก Prisma / DTO · `src/lib/env.ts` · DTO money เป็น string/satang ที่ boundary

### 8. 🟡 Domain & Compliance ที่ขาด (critic ข้ามมิติ)
- **ไม่มี backup / PITR / DR** — `docker compose down -v` = บัญชีขายหายถาวร
- **ไม่มีใบเสร็จ / ใบกำกับภาษี (ใบกำกับภาษี)** — ผิดกฎสรรพากรทันทีที่จด VAT (ต้องมีเลขรันต่อเนื่อง, TIN ผู้ขาย, แยก VAT 7%)
- **ไม่มี reporting / Z-report / กระทบยอดเงินสดปลายวัน (reconciliation / shift close)**
- ไม่มี timezone Asia/Bangkok (UTC+7) → "ยอดวันนี้" เพี้ยนข้ามวันตอน 07:00
- ไม่มี PDPA handling · ไม่มี data-retention (~5 ปีตามกฎภาษีไทย) · ไม่มี offline/PWA · ไม่มี multi-tab concurrency · ไม่มี a11y · ไม่มี dependency/supply-chain policy

---

## ⛑️ TOP — ต้องแก้ทันที (เลือดไหล, effort ต่ำ, ทำได้วันนี้)
1. ลบ credential จริงออกจาก `README.md` (และ rotate)
2. แก้ `GET /api/orders` ให้ `select: { cashier: { select: { id:true, name:true } } }` — ปิดช่องรั่วรหัสผ่าน (ทำได้ก่อนมี auth)
3. ย้าย DB password ออกจาก `docker-compose.yml` → env, **ไม่ publish port 5432**, เลิกใช้ superuser
4. `npm install` → commit `package-lock.json` + เพิ่ม `public/.gitkeep` (ให้ Docker build ผ่าน)

---

## 🗺️ Roadmap แนะนำ (เรียงตาม dependency)

| Phase | เป้าหมาย | สิ่งที่ทำ |
|---|---|---|
| **0 — Stop the bleeding** | ปิดช่องอันตรายเฉพาะหน้า | 4 ข้อ TOP ด้านบน |
| **1 — Security & validation foundation** | ตั้งฐานความปลอดภัย | Zod validation + error handling ทุก route · hash passwords · Auth.js/Lucia + middleware + RBAC + cashierId จาก session · env module |
| **2 — Financial/inventory correctness** | ทำให้ "หัวใจ POS" ถูกต้อง | Decimal/satang + `lib/pricing.ts` service · server recompute + ตรวจ amountPaid/discount/taxRate · atomic stock decrement + CHECK + isolation · idempotency · orderNumber sequence · refund/void + audit log |
| **3 — Quality gates & deploy hardening** | กันการถดถอย + deploy ได้จริง | Vitest + test-DB harness + Playwright + coverage · CI (GitHub Actions) + gitleaks · prisma migrate (versioned) + migrate deploy + bootstrap · health endpoint + standalone + least-priv DB role + limits · pino + correlation ID + Sentry + error boundary |
| **4 — Domain & compliance** | ทำให้เป็นร้านจริง/ถูกกฎหมาย | ใบเสร็จ + ใบกำกับภาษี (เลขรัน + VAT 7%) · reporting + Z-report + reconciliation + tz Asia/Bangkok · backups/PITR + DR runbook · PDPA + data retention · offline/PWA + multi-tab concurrency · a11y + supply-chain policy |

---

## หมายเหตุวิธีการ
รายงานนี้ผลิตด้วย ~15 subagent: ผู้ตรวจ 1 ตัว/มิติ (auth, input-api, financial, testing, infra-deploy, observability, architecture) → ผู้ตรวจสอบ adversarial อีก 1 ตัว/มิติ ที่อ่านซอร์สเดิมซ้ำเพื่อยืนยัน/ลดระดับ/ปฏิเสธแต่ละข้อ และเพิ่มข้อที่ผู้ตรวจแรกพลาด → critic 1 ตัวหาหมวดที่ข้ามมิติ. ทุกข้ออ้างอิงโค้ดจริง ไม่ใช่การคาดเดา
