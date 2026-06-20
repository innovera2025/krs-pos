import { NavRail } from "@/components/NavRail";

/**
 * App shell layout (Server Component). The (shell) route group adds no URL
 * segment — it only wraps its children with the persistent forest rail and a
 * flexible main workspace so every routed screen drops into a consistent frame.
 */
export default function ShellLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <div className="flex h-screen">
      <NavRail />
      <main className="flex-1 min-w-0">{children}</main>
    </div>
  );
}
