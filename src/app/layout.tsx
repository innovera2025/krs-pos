import type { Metadata } from "next";
import { IBM_Plex_Sans_Thai, IBM_Plex_Mono } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/components/ToastProvider";
import { RoleProvider } from "@/components/RoleProvider";

const sans = IBM_Plex_Sans_Thai({
  weight: ["400", "500", "600", "700"],
  subsets: ["thai", "latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "KRS POS",
  description: "Point of Sale system",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="th" className={`${sans.variable} ${mono.variable}`}>
      <body className="min-h-screen font-sans antialiased">
        {/* RoleProvider is a DEMO role stub (not security) consumed by the rail
            filter + admin page guards; ToastProvider stays innermost so any
            screen can fire toasts. Both are client boundaries; layout stays a
            Server Component. */}
        <RoleProvider>
          <ToastProvider>{children}</ToastProvider>
        </RoleProvider>
      </body>
    </html>
  );
}
