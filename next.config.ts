import type { NextConfig } from "next";

// Served at the root of inspections.stressfreepm.ca.
const nextConfig: NextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_BASE_PATH: "" },
  poweredByHeader: false,
};

export default nextConfig;
