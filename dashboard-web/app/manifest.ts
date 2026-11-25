import type { MetadataRoute } from "next";

// Makes "Add to Home Screen" / "Install app" produce a proper app: its own
// icon and name, opening full-screen without browser chrome.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ESP32 Weather Monitor",
    short_name: "Weather",
    description: "Temperature and humidity from the ESP32 weather station",
    start_url: "/",
    display: "standalone",
    background_color: "#0f1419",
    theme_color: "#0f1419",
    icons: [
      // The artwork keeps its glyphs inside the central safe zone, so the
      // same files also work as maskable (cropped) Android icons.
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
