import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  // The shared-types workspace package ships raw TypeScript (main -> src/index.ts,
  // no build step) so Next must transpile it just like the worker/api runtimes do.
  transpilePackages: ["@clothing-line-project/shared-types"],
};

export default nextConfig;
