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
  // Force the in-product kiosk-print setup file to DOWNLOAD rather than render as
  // text. Without Content-Disposition: attachment some browsers (macOS/Linux) open
  // a .bat as plain text in the tab. The <a download> attribute on the onboarding
  // modal handles most modern browsers; this server header is the reliable fallback.
  // Custom headers ARE applied in output: "standalone" mode (standard Next.js).
  async headers() {
    return [
      {
        source: "/kiosk-print-setup.bat",
        headers: [
          {
            key: "Content-Disposition",
            value: 'attachment; filename="kiosk-print-setup.bat"',
          },
          {
            key: "Content-Type",
            value: "application/octet-stream",
          },
        ],
      },
      {
        // macOS counterpart. Same force-download treatment so a downloaded
        // .command lands as an executable file rather than opening as text.
        source: "/kiosk-print-setup-mac.command",
        headers: [
          {
            key: "Content-Disposition",
            value: 'attachment; filename="kiosk-print-setup-mac.command"',
          },
          {
            key: "Content-Type",
            value: "application/octet-stream",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
