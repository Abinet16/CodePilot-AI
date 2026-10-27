import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Compile the shared contracts package from source.
  transpilePackages: ["@codepilot/contracts"],
  poweredByHeader: false,
};

export default nextConfig;
