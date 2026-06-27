// NODE-ONLY product-image proxy + disk cache (product images mapped by KRS
// PictureName). The product master carries a raw image FILENAME on
// `Product.imageUrl` (imported from KRS `PictureName`, e.g. "F01-0001.JPG"). The
// actual bytes live on a plain FTP server that the browser cannot reach, so this
// route resolves sku → filename, fetches the file over FTP (basic-ftp, Node-only),
// caches it on local disk, and serves it. The client `<img>` falls back to a
// category icon on any non-2xx, so almost every failure path here degrades to 404
// ("no image available"). The ONE exception is a genuine DB fault while resolving
// sku → filename: that is a real server problem and returns a sanitized 500 (the
// <img> still shows the icon fallback regardless of the status code).
//
// runtime = nodejs + dynamic = force-dynamic keep this off the edge/client bundle:
// basic-ftp uses node:net/node:fs and MUST NOT be pulled into an edge runtime.
import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Client as FtpClient } from "basic-ftp";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { requireUser } from "@/lib/auth";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only safe sku characters — also blocks path separators so `code` can never
 *  escape the cache directory or build a traversal remote path. */
const CODE_RE = /^[A-Za-z0-9_.\-]+$/;

/** Hard cap on a downloaded image (8 MiB). A larger remote file is rejected (→404)
 *  BEFORE its bytes are pulled, via a cheap SIZE command. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** FTP control+data op timeout (ms). Bounds a KRS FTP outage so a request can't
 *  hang on the basic-ftp default (~30s). Applied via the Client constructor —
 *  `ftp.timeout` is a readonly property in the basic-ftp types, so the constructor
 *  argument is the type-safe way to set it; it covers both control and data ops. */
const FTP_TIMEOUT_MS = 8000;

/** Negative-cache TTL (ms): after one FTP failure for a key we skip re-opening an
 *  FTP socket for that key for this long. */
const NEG_CACHE_TTL_MS = 60_000;

/** Prune the negative cache once it grows past this many entries. */
const NEG_CACHE_MAX = 500;

/**
 * Negative cache: cacheKey → expiry epoch ms. A key present with expiry > now
 * means "this image recently failed to fetch; do not re-open FTP yet". This stops
 * a missing/unreachable image from re-opening an FTP socket on every grid render
 * during an outage. Module-level (per server process); fail-open by design.
 */
const negCache = new Map<string, number>();

/**
 * In-flight FTP fetches: cachePath → the pending fetch promise. Concurrent
 * requests for the SAME image await the existing fetch instead of opening a
 * second FTP connection. The promise resolves to the image Buffer or null (→404).
 */
const inflight = new Map<string, Promise<Buffer | null>>();

/** Record a key as recently-failed and opportunistically prune expired entries. */
function negCacheSet(key: string): void {
  negCache.set(key, Date.now() + NEG_CACHE_TTL_MS);
  if (negCache.size > NEG_CACHE_MAX) {
    const now = Date.now();
    for (const [k, expiry] of negCache) {
      if (expiry <= now) negCache.delete(k);
    }
  }
}

/** Empty-body 404 → the client `<img onError>` falls back to the category icon. */
function notFound(): NextResponse {
  return new NextResponse(null, { status: 404 });
}

/** Map a filename extension to an image Content-Type (default octet-stream). */
function contentTypeFor(filename: string): string {
  switch (path.extname(filename).toLowerCase()) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".png":
      return "image/png";
    case ".gif":
      return "image/gif";
    default:
      return "application/octet-stream";
  }
}

/** Serve image bytes. The response is now AUTHENTICATED (requireUser gate), so the
 *  cache header is `private` — it must never be stored by a shared/CDN cache. A
 *  fresh Uint8Array keeps the body a clean BodyInit (the Node Buffer is copied once
 *  — cheap for one image). `nosniff` blocks content-type sniffing. */
function imageResponse(bytes: Buffer, filename: string): NextResponse {
  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": contentTypeFor(filename),
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Fetch one image over FTP into the disk cache and return its bytes (or null on any
 * failure → 404). Fail-open: a missing / oversized / unreachable file resolves to
 * null and is negative-cached, never throws. Downloads into a unique temp file and
 * atomically renames it into place so a concurrent reader never sees a partial file.
 */
async function fetchImageOverFtp(opts: {
  host: string;
  user: string;
  password: string;
  secure: boolean;
  remotePath: string;
  cachePath: string;
  cacheKey: string;
}): Promise<Buffer | null> {
  const { host, user, password, secure, remotePath, cachePath, cacheKey } = opts;
  const tmpPath = `${cachePath}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}`;
  const client = new FtpClient(FTP_TIMEOUT_MS);
  try {
    await client.access({ host, port: 21, user, password, secure });

    // Cheap SIZE command before pulling bytes: reject an oversized file up-front.
    // A 550 (file-not-found) throws here and is handled as the normal FTP-error
    // 404 path in the catch below.
    const remoteSize = await client.size(remotePath);
    if (remoteSize > MAX_IMAGE_BYTES) {
      negCacheSet(cacheKey);
      logger.warn(
        { remote: remotePath, remoteSize },
        "KRS image exceeds size cap; skipping download"
      );
      return null;
    }

    await client.downloadTo(tmpPath, remotePath);
  } catch (err) {
    // FTP error / file-not-found (FTPError code 550) / timeout → 404 (NOT 500) so
    // the client shows the icon fallback. Negative-cache the key so an outage does
    // not re-open a socket per render. Log ONLY a sanitized FTP code + the
    // (credential-free) remote path — never the host/user/password.
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    negCacheSet(cacheKey);
    logger.warn(
      { ftpCode: (err as { code?: unknown }).code, remote: remotePath },
      "KRS image FTP fetch failed"
    );
    return null;
  } finally {
    client.close();
  }

  // Publish the temp file into the cache atomically, then read + return. A rename
  // failure (e.g. raced by another fetch) falls back to serving the temp bytes.
  try {
    await fs.rename(tmpPath, cachePath);
    return await fs.readFile(cachePath);
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "KRS image cache publish failed; serving temp bytes"
    );
    try {
      const bytes = await fs.readFile(tmpPath);
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      return bytes;
    } catch {
      await fs.rm(tmpPath, { force: true }).catch(() => {});
      return null;
    }
  }
}

// GET /api/products/image?code={sku}
//
// AUTH: requires an authenticated session (requireUser, mirroring GET /api/products).
// The POS <img> sends the session cookie same-origin so the grid keeps working; an
// unauthenticated caller gets 401. Resolves the sku's KRS image filename and serves
// the file (disk-cache first, FTP on a miss). Every non-DB failure degrades to 404
// (the client shows the category icon); a genuine DB fault is a sanitized 500.
export async function GET(req: Request) {
  // 0) AUTH gate (defense-in-depth) — reject before any DB/FTP work.
  const gate = await requireUser();
  if ("response" in gate) return gate.response;

  const code = new URL(req.url).searchParams.get("code") ?? "";

  // 1) Validate the sku/code. The regex also guarantees no '/'/'\\' so a code can
  //    never traverse out of the cache dir. A length bound is defensive hygiene.
  if (code.length === 0 || code.length > 128 || !CODE_RE.test(code)) {
    return NextResponse.json(
      { error: "invalid code", code: "BAD_REQUEST" },
      { status: 400 }
    );
  }

  // 2) FTP must be configured; otherwise the feature is simply inactive → 404.
  const host = (env.KRS_FTP_HOST ?? "").trim();
  const user = (env.KRS_FTP_USER ?? "").trim();
  const password = env.KRS_FTP_PASS ?? "";
  if (host === "" || user === "" || password === "") return notFound();

  const company = (env.KRS_FTP_COMPANY ?? "SNP").trim() || "SNP";
  const basePath = (env.KRS_FTP_BASEPATH ?? "updateEXE").trim() || "updateEXE";
  const cacheDir = (env.KRS_IMAGE_CACHE_DIR ?? "/tmp/krs-images").trim() || "/tmp/krs-images";
  // Explicit FTPS (AUTH TLS) opt-in. Default false = plain FTP (what the KRS store
  // speaks today per probe); secure:false keeps existing behavior unchanged.
  const secure = env.KRS_FTP_SECURE === "true";

  // 3) Resolve sku → image filename. Unknown sku or no/blank filename → 404 (the
  //    product has no mapped image; the client shows the icon).
  let filename: string;
  try {
    const product = await prisma.product.findFirst({
      where: { sku: code },
      select: { imageUrl: true },
    });
    const raw = product?.imageUrl?.trim() ?? "";
    if (raw === "") return notFound();
    filename = raw;
  } catch (err) {
    // A genuine DB fault is a real server problem — log (sanitized) + 500. The
    // <img> still falls back to the icon regardless of the status code.
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      "GET /api/products/image product lookup failed"
    );
    return NextResponse.json({ error: "INTERNAL", code: "INTERNAL" }, { status: 500 });
  }

  // 4) Path-traversal guard on the filename itself (it comes from KRS data, not the
  //    client, but is still untrusted): reject separators / parent refs → 404.
  if (
    filename.includes("/") ||
    filename.includes("\\") ||
    filename.includes("..")
  ) {
    return notFound();
  }

  // 5) Build a collision-free cache key + path. The sku is unique and maps to one
  //    image, so `${sku}${ext}` cannot alias another product's file. Keep the
  //    prefix-check traversal guard on the resolved cachePath.
  const ext = path.extname(filename).toLowerCase();
  const cacheKey = `${code}${ext}`;
  const resolvedDir = path.resolve(cacheDir);
  const cachePath = path.join(resolvedDir, cacheKey);
  if (cachePath !== resolvedDir && !cachePath.startsWith(resolvedDir + path.sep)) {
    return notFound();
  }

  // Ensure the cache dir exists (recursive: no-op when already present).
  try {
    await fs.mkdir(resolvedDir, { recursive: true });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "KRS image cache dir create failed"
    );
    return notFound();
  }

  // 6) Cache hit → serve from disk. ENOENT = miss (fall through to FTP); any other
  //    read error is logged and also falls through to a fresh fetch.
  try {
    const cached = await fs.readFile(cachePath);
    return imageResponse(cached, filename);
  } catch (err) {
    const code2 = (err as NodeJS.ErrnoException).code;
    if (code2 !== "ENOENT") {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "KRS image cache read failed; refetching"
      );
    }
    // fall through to FTP fetch
  }

  // 7) Negative cache: a recent FTP failure for this key short-circuits to 404
  //    WITHOUT touching FTP — keeps a missing/unreachable image from re-opening a
  //    socket on every grid render during an outage (fail-open).
  const negExpiry = negCache.get(cacheKey);
  if (negExpiry !== undefined && negExpiry > Date.now()) {
    return notFound();
  }

  // 8) Cache miss → fetch over FTP, deduped across concurrent requests for the SAME
  //    image (keyed by cachePath). Concurrent callers await one fetch instead of
  //    opening a second FTP connection; the entry clears in `finally`.
  const remotePath = `${basePath}/${company}/Image/${filename}`;
  let fetchPromise = inflight.get(cachePath);
  if (!fetchPromise) {
    fetchPromise = fetchImageOverFtp({
      host,
      user,
      password,
      secure,
      remotePath,
      cachePath,
      cacheKey,
    }).finally(() => {
      inflight.delete(cachePath);
    });
    inflight.set(cachePath, fetchPromise);
  }

  const bytes = await fetchPromise;
  if (bytes === null) return notFound();
  return imageResponse(bytes, filename);
}
