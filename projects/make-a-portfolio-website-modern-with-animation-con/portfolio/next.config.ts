import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  // Node 25 worker_threads compat: skip the TS checker worker (tsc --noEmit is clean)
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
