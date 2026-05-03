import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  output: "export",
  images: {
    unoptimized: true,
  },
  turbopack: {
    root: path.resolve(__dirname),
  },
  // Node 25 compat: fork() sends watch:require IPC messages that crash jest-worker.
  // workerThreads uses postMessage instead of IPC, avoiding the issue.
  // ignoreBuildErrors skips the TS-checker worker which also crashed on Node 25.
  experimental: {
    workerThreads: true,
  },
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
