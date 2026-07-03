/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle (.next/standalone/server.js) with only the
  // traced node_modules it needs. The production Docker runner copies that bundle
  // instead of the full node_modules tree → much smaller image + faster cold start.
  // NOTE: standalone tracing does NOT pick up Prisma's native query-engine binary;
  // the Dockerfile runner copies node_modules/.prisma + @prisma/client explicitly.
  output: "standalone",
  // Build output dir. Defaults to ".next". An optional NEXT_DIST_DIR override lets a
  // verification `next build` run into an isolated dir WITHOUT clobbering a `next dev`
  // server's live `.next` (which would corrupt the dev server's incremental build).
  // Production/dev with the var unset are unaffected (= ".next").
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
