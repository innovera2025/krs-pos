// NODE-ONLY. Uses the Node `crypto` built-in (AES-256-GCM). Do NOT import this
// from a client component, `src/auth.config.ts`, or `src/middleware.ts` — it is
// imported only by Node-runtime server code (the KRS API routes + client).
//
// AES-256-GCM encrypt/decrypt for the single secret the POS stores: the KRS SQL
// Server password (krs-sync P1, P0 spec §2). Key from `KRS_CONFIG_ENC_KEY`
// (base64 → exactly 32 bytes). Confidentiality + integrity: the GCM auth tag
// detects tampering / wrong key / AAD mismatch (fails closed). A fixed AAD binds
// the ciphertext to its purpose so a blob from some OTHER field encrypted under
// the same key cannot be cross-decrypted into the password slot. Stored format is
// `v1:<ivHex>:<tagHex>:<ctHex>` — the leading version tag lets a future rotation
// distinguish a wrong key vintage from a tampered blob.

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

/**
 * Thrown by `loadKey` when `KRS_CONFIG_ENC_KEY` is missing/empty or does not decode
 * to exactly 32 bytes. A DISTINCT class (vs a plain Error from a network/driver
 * fault) so callers — the test-connection + schema routes — can surface a clear,
 * non-sensitive "server encryption key missing/invalid" message instead of mis-
 * reporting a server-config problem as a generic KRS connection failure (security
 * F3). Carries no secret material (the message names the env var only).
 */
export class KrsKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KrsKeyError";
  }
}

/**
 * Fixed context-binding Additional Authenticated Data (P0 spec §2.3). Set on
 * BOTH encrypt and decrypt. It is authenticated but NOT encrypted; a mismatch
 * (e.g. a blob produced for a different field/version) fails the GCM tag check.
 * Bump this label in lockstep with the version tag below if the scheme changes.
 */
const AAD = Buffer.from("krs.connection.password.v1");

/** The scheme/key-vintage tag — the first segment of the stored blob (§2.2). */
const VERSION = "v1";

/** GCM-recommended IV length: 12 bytes (96 bits). 24 hex chars when serialized. */
const IV_BYTES = 12;

/** Hex-segment validators (§2.4 step 3). `Buffer.from(x, "hex")` silently
 *  truncates on bad/odd hex rather than throwing, so we gate on these regexes
 *  BEFORE constructing any Buffer — turning a malformed blob into a clean
 *  "corrupt ciphertext" error instead of a confusing downstream crypto failure. */
const IV_HEX_RE = /^[0-9a-f]{24}$/; // 12 bytes
const TAG_HEX_RE = /^[0-9a-f]{32}$/; // 16 bytes
const CT_HEX_RE = /^[0-9a-f]+$/; // any non-empty hex; even length asserted separately

/**
 * Load + validate the AES-256 key from the environment. Fail-fast at the CALLSITE
 * (P0 spec §2.1) — NOT at module load — so a non-KRS deploy still boots and only a
 * real KRS write/connect trips a missing/invalid key. Never returns an unvalidated
 * key; never falls back to plaintext.
 */
function loadKey(): Buffer {
  const raw = process.env.KRS_CONFIG_ENC_KEY;
  if (!raw || raw.length === 0) {
    throw new KrsKeyError(
      "KRS_CONFIG_ENC_KEY is required to encrypt/decrypt the KRS connection password. " +
        "Generate one with: openssl rand -base64 32"
    );
  }
  const keyBuf = Buffer.from(raw, "base64");
  if (keyBuf.length !== 32) {
    throw new KrsKeyError(
      `KRS_CONFIG_ENC_KEY must decode to exactly 32 bytes (AES-256). Got ${keyBuf.length} bytes.`
    );
  }
  return keyBuf;
}

/**
 * Encrypt `plaintext` (the KRS password) → `v1:<ivHex>:<tagHex>:<ctHex>`.
 *
 * A FRESH random 12-byte IV is generated per call (never reused — even re-saving
 * the same password gets a new IV). The fixed AAD is set BEFORE `update`.
 */
export function encrypt(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return (
    VERSION +
    ":" +
    iv.toString("hex") +
    ":" +
    authTag.toString("hex") +
    ":" +
    ciphertext.toString("hex")
  );
}

/**
 * Decrypt a `v1:<ivHex>:<tagHex>:<ctHex>` blob → the original plaintext.
 *
 * Validates structure (4 non-empty parts), version (`v1`), and each hex segment's
 * shape/length BEFORE constructing Buffers (§2.4). The GCM `final()` throws on any
 * auth-tag mismatch (tampering, wrong key, OR wrong AAD) — that error is allowed
 * to propagate as the integrity + context-binding guarantee.
 */
export function decrypt(blob: string): string {
  const key = loadKey();

  const parts = blob.split(":");
  if (parts.length !== 4 || parts.some((p) => p.length === 0)) {
    throw new Error("corrupt ciphertext: expected v1:ivHex:authTagHex:ciphertextHex");
  }
  const [version, ivHex, authTagHex, ciphertextHex] = parts;

  if (version !== VERSION) {
    throw new Error("unknown ciphertext version: " + version);
  }
  if (
    !IV_HEX_RE.test(ivHex) ||
    !TAG_HEX_RE.test(authTagHex) ||
    !CT_HEX_RE.test(ciphertextHex) ||
    ciphertextHex.length % 2 !== 0
  ) {
    throw new Error("corrupt ciphertext: malformed hex segment");
  }

  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(authTagHex, "hex"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextHex, "hex")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
