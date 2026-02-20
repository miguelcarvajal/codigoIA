import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vocento Article Exporter",
  description: "Exporta artículos de autoras y autores de diarios del grupo Vocento.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  );
}
