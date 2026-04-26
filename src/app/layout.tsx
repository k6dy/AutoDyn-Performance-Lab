import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AutoDyn Benchmark",
  description:
    "Vehicle performance simulation and benchmark comparison tool.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning data-scroll-behavior="smooth">
      <body>{children}</body>
    </html>
  );
}