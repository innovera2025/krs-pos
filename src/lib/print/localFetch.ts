/**
 * `RequestInit` extended with `targetAddressSpace` — a newish fetch option that
 * is NOT yet in TypeScript's lib.dom `RequestInit`.
 *
 * Chrome's Local Network Access (formerly Private Network Access) BLOCKS a
 * public HTTPS site (e.g. krspos.innoveraappcenter.com) from fetching a
 * loopback/private address (the local print agent on http://localhost:9100)
 * UNLESS the fetch explicitly opts in with `targetAddressSpace: "private"` AND
 * the agent answers the CORS/PNA preflight with
 * `Access-Control-Allow-Private-Network: true` (which krs-print-agent already
 * does — see tools/krs-print-agent/index.js `setCorsHeaders`).
 *
 * This is a narrow, typed extension so every print-agent fetch can pass
 * `targetAddressSpace` without an `any` or `@ts-ignore`. A value of this type is
 * still assignable to `RequestInit`, so it can be passed straight to `fetch`.
 */
export type LocalFetchInit = RequestInit & {
  targetAddressSpace?: "private" | "local" | "public";
};
