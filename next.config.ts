import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV === "development";
// The Vercel Toolbar is injected on Preview deployments only.
const isPreview = process.env.VERCEL_ENV === "preview";
const toolbar = (sources: string) => (isPreview ? ` ${sources}` : "");

// The browser only talks to this origin: vehicle providers and Gemini are called server-side.
// 'unsafe-inline' scripts are required by Next.js hydration without per-request nonces
// (nonces would force dynamic rendering of every page); no 'unsafe-eval' in production.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}${toolbar("https://vercel.live")}`,
  `style-src 'self' 'unsafe-inline'${toolbar("https://vercel.live")}`,
  `img-src 'self' data: blob:${toolbar("https://vercel.live https://vercel.com")}`,
  `font-src 'self' data:${toolbar("https://vercel.live https://assets.vercel.com")}`,
  `connect-src 'self'${toolbar("https://vercel.live wss://ws-us3.pusher.com")}`,
  `frame-src ${isPreview ? "https://vercel.live" : "'none'"}`,
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "upgrade-insecure-requests",
].join("; ");

const nextConfig: NextConfig = {
  poweredByHeader: false,
  turbopack: { root: process.cwd() },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default nextConfig;
