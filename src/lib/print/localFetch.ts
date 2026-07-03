/**
 * `RequestInit` extended with `targetAddressSpace` — a newish fetch option that
 * is NOT yet in TypeScript's lib.dom `RequestInit`.
 *
 * Chrome's Local Network Access (formerly Private Network Access) BLOCKS a
 * public HTTPS site (e.g. krspos.innoveraappcenter.com) from fetching a
 * loopback/private address (the local print agent on http://localhost:9100)
 * unless the fetch explicitly declares the target's address space.
 *
 * ADDRESS-SPACE TAXONOMY (current Chrome / LNA — verified against the shop's
 * Chrome on 03-07-26): `localhost`/`127.0.0.1` is space `"loopback"`; RFC1918
 * LAN addresses are `"local"` (the legacy PNA name for that space was
 * `"private"`, which current Chrome still maps to `"local"`). Declaring
 * `"private"` for a localhost fetch therefore FAILS on current Chrome with
 * "Request had a target IP address space of `local` yet the resource is in
 * address space `loopback`" — the agent MUST be fetched with
 * `targetAddressSpace: "loopback"`. The agent additionally answers the
 * CORS/PNA preflight with `Access-Control-Allow-Private-Network: true`
 * (see tools/krs-print-agent/index.js `setCorsHeaders`).
 *
 * This is a narrow, typed extension so every print-agent fetch can pass
 * `targetAddressSpace` without an `any` or `@ts-ignore`. A value of this type is
 * still assignable to `RequestInit`, so it can be passed straight to `fetch`.
 */
export type LocalFetchInit = RequestInit & {
  targetAddressSpace?: "loopback" | "local" | "private" | "public";
};
