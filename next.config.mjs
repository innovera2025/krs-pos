/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle (.next/standalone/server.js) with only the
  // traced node_modules it needs. The production Docker runner copies that bundle
  // instead of the full node_modules tree → much smaller image + faster cold start.
  // NOTE: standalone tracing does NOT pick up Prisma's native query-engine binary;
  // the Dockerfile runner copies node_modules/.prisma + @prisma/client explicitly.
  output: "standalone",
};

export default nextConfig;
