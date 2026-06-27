// NODE-ONLY product-image proxy + disk cache (product images mapped by KRS
// PictureName). The product master carries a raw image FILENAME on
// `Product.imageUrl` (imported from KRS `PictureName`, e.g. "F01-0001.JPG"). The
// actual bytes live on a plain HTTP server that the BROWSER cannot load directly:
// the POS is served over HTTPS, so an `http://` <img> is blocked as mixed content.
// This route resolves sku → filename, fetches the file over plain HTTP server-side
// (Node fetch), caches it on local disk, and serves it same-origin over HTTPS. The
// client `<img>` falls back to a category icon on any non-2xx, so almost every
// failure path here degrades to 404 ("no image available"). The ONE exception is a
// genuine DB fault while resolving sku → filename: that is a real server problem and
// returns a sanitized 500 (the <img> still shows the icon fallback regardless of
// the status code).
//
// runtime = nodejs + dynamic = force-dynamic keep this off the edge/client bundle:
// the route uses node:fs/node:path for the disk cache and MUST NOT be pulled into an
// edge runtime.
import { NextResponse } from "next/server";
import { promises as fs } from "node:fs";
import path from "node:path";
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
 *  up-front via the Content-Length header when present, and again after the body is
 *  read (a missing/lying Content-Length is still bounded). */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

/** HTTP fetch timeout (ms). Bounds a KRS image-server outage so a request can't hang
 *  on the platform default. Applied via an AbortController signal that covers the
 *  whole fetch (connect + response). */
const HTTP_TIMEOUT_MS = 8000;

/** Negative-cache TTL (ms): after one fetch failure for a key we skip re-fetching
 *  over HTTP for that key for this long. */
const NEG_CACHE_TTL_MS = 60_000;

/** Prune the negative cache once it grows past this many entries. */
const NEG_CACHE_MAX = 500;

/**
 * Negative cache: cacheKey → expiry epoch ms. A key present with expiry > now
 * means "this image recently failed to fetch; do not re-fetch over HTTP yet". This
 * stops a missing/unreachable image from issuing an HTTP request on every grid
 * render during an outage. Module-level (per server process); fail-open by design.
 */
const negCache = new Map<string, number>();

/**
 * In-flight HTTP fetches: cachePath → the pending fetch promise. Concurrent
 * requests for the SAME image await the existing fetch instead of issuing a
 * second HTTP request. The promise resolves to the image Buffer or null (→404).
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
 * Fetch one image over plain HTTP into the disk cache and return its bytes (or null
 * on any failure → 404). Fail-open: a missing / oversized / unreachable file resolves
 * to null and is negative-cached, never throws. Downloads into a unique temp file and
 * atomically renames it into place so a concurrent reader never sees a partial file.
 *
 * SSRF: `url` is built from env-fixed host + company + a sanitized, encoded filename
 * (see GET) — the request controls only `code`, never the host. Keep it that way.
 */
async function fetchImageOverHttp(opts: {
  url: string;
  cachePath: string;
  cacheKey: string;
}): Promise<Buffer | null> {
  const { url, cachePath, cacheKey } = opts;
  const tmpPath = `${cachePath}.tmp.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2)}`;
  // Bound the fetch with an AbortController (replaces the old FTP op timeout).
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });

    // Non-2xx (404/403/500/…) → fail-open 404 + negative-cache. Log a sanitized
    // status + the (host-fixed, env-controlled, credential-free) URL.
    if (!res.ok) {
      negCacheSet(cacheKey);
      logger.warn(
        { status: res.status, url },
        "KRS image HTTP fetch returned non-2xx"
      );
      return null;
    }

    // Cheap up-front size guard: reject an oversized file via Content-Length BEFORE
    // buffering its bytes (when the header is present + parses to a finite number).
    const lenHeader = res.headers.get("content-length");
    if (lenHeader !== null) {
      const declared = Number.parseInt(lenHeader, 10);
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        negCacheSet(cacheKey);
        logger.warn(
          { url, declared },
          "KRS image exceeds size cap (content-length); skipping download"
        );
        return null;
      }
    }

    const buf = Buffer.from(await res.arrayBuffer());

    // Post-read guard: a missing/lying Content-Length is still bounded here — a body
    // over the cap is discarded (never written to the cache).
    if (buf.byteLength > MAX_IMAGE_BYTES) {
      negCacheSet(cacheKey);
      logger.warn(
        { url, bytes: buf.byteLength },
        "KRS image exceeds size cap (body); discarding"
      );
      return null;
    }

    // Write the bytes to a unique temp file; the atomic publish happens after the
    // try/catch/finally so a partial write never lands in the cache.
    await fs.writeFile(tmpPath, buf);
  } catch (err) {
    // Network error / DNS failure / timeout (AbortError) → 404 (NOT 500) so the
    // client shows the icon fallback. Negative-cache the key so an outage does not
    // issue an HTTP request per render. Log ONLY a sanitized message + the
    // (credential-free, env-fixed-host) URL.
    await fs.rm(tmpPath, { force: true }).catch(() => {});
    negCacheSet(cacheKey);
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), url },
      "KRS image HTTP fetch failed"
    );
    return null;
  } finally {
    clearTimeout(timer);
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
// the file (disk-cache first, plain-HTTP fetch on a miss). Every non-DB failure
// degrades to 404 (the client shows the category icon); a genuine DB fault is a
// sanitized 500.
export async function GET(req: Request) {
  // 0) AUTH gate (defense-in-depth) — reject before any DB/network work.
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

  // 2) Resolve the image-source config. Defaults are baked in (host + company are
  //    env-FIXED, never request-controlled), so the feature is always active: a
  //    deploy serves product images with no extra env. The request controls only
  //    `code`; the URL host can never be steered by the caller (SSRF-safe, step 8).
  const baseUrl = (env.KRS_IMAGE_BASE_URL ?? "http://43.229.134.162/update").replace(
    /\/+$/,
    ""
  );
  const company = env.KRS_IMAGE_COMPANY ?? "SNP";
  const cacheDir =
    (env.KRS_IMAGE_CACHE_DIR ?? "/tmp/krs-images").trim() || "/tmp/krs-images";

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

  // 6) Cache hit → serve from disk. ENOENT = miss (fall through to fetch); any other
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
    // fall through to HTTP fetch
  }

  // 7) Negative cache: a recent fetch failure for this key short-circuits to 404
  //    WITHOUT issuing an HTTP request — keeps a missing/unreachable image from
  //    re-fetching on every grid render during an outage (fail-open).
  const negExpiry = negCache.get(cacheKey);
  if (negExpiry !== undefined && negExpiry > Date.now()) {
    return notFound();
  }

  // 8) Cache miss → fetch over plain HTTP, deduped across concurrent requests for the
  //    SAME image (keyed by cachePath). Concurrent callers await one fetch instead of
  //    issuing a second HTTP request; the entry clears in `finally`.
  //
  //    URL = {base}/{company}/Image/Drawing/{PictureName}. host + company are
  //    env-fixed; the filename is sanitized (steps 1+4) and encodeURIComponent'd, so
  //    the caller controls no part of the host/authority → no SSRF.
  const url = `${baseUrl}/${company}/Image/Drawing/${encodeURIComponent(filename)}`;
  let fetchPromise = inflight.get(cachePath);
  if (!fetchPromise) {
    fetchPromise = fetchImageOverHttp({
      url,
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
