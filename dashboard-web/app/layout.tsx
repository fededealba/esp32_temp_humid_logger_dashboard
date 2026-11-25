import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: "ESP32 Weather Monitor",
  description: "Temperature and humidity dashboard for an ESP32 weather station",
  // "Add to Home Screen" on iOS: open full-screen like an app, with a short
  // name under the icon. Icons come from app/icon.svg and app/apple-icon.png.
  appleWebApp: {
    title: "Weather",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Lets the page extend under the iPhone notch / home bar; globals.css
  // pads with env(safe-area-inset-*) so nothing ends up behind them.
  viewportFit: "cover",
  // Browser/status bar color, matching the page background in each scheme.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f6f7f8" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1419" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
