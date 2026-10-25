import type { Metadata, Viewport } from "next";

// Fuentes incluidas en el proyecto (sin depender de servicios externos).
import "@fontsource/caveat/latin-700.css";
import "@fontsource/instrument-sans/latin-400.css";
import "@fontsource/instrument-sans/latin-500.css";
import "@fontsource/instrument-sans/latin-600.css";
import "./globals.css";
import "./collaboard-p2.css";

import { Toaster } from "@/ui/common/Toaster";

export const metadata: Metadata = {
  title: { default: "CollaBoard", template: "%s · CollaBoard" },
  description: "Pizarra colaborativa en tiempo real: dibuja, conversa y comparte tableros con tu equipo.",
  icons: { icon: "/favicon.svg" },
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#f7f9fb",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es">
      <body>
        {children}
        <Toaster />
      </body>
    </html>
  );
}
