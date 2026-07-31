import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Passenger Behaviour Survey",
  description: "Real-time multi-surveyor pedestrian flow tracking",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#0B0D0E",
  // a tally button must not zoom on double-tap
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="h-full antialiased">
        {children}
        {/* Credit, bottom-right on every screen. pointer-events-none so it can
            never intercept a tap meant for the counting buttons underneath. */}
        <footer
          aria-label="Credit"
          className="pointer-events-none fixed bottom-0 right-0 z-[60] select-none
                     pb-[calc(env(safe-area-inset-bottom)+4px)] pr-3 text-[11px]
                     leading-none text-ash/60"
        >
          © Chamod Wismantha
        </footer>
      </body>
    </html>
  );
}
