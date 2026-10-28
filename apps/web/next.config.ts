import type { NextConfig } from "next";

const API_ORIGIN = process.env.API_ORIGIN ?? "http://localhost:4000";

const nextConfig: NextConfig = {
  // Compile the shared contracts package from source.
  transpilePackages: ["@codepilot/contracts"],
  poweredByHeader: false,
  // Browsers only ever talk to this origin. /api is proxied to the NestJS API,
  // so session cookies are first-party and SameSite=Lax protects mutations.
  async rewrites() {
    return [{ source: "/api/:path*", destination: `${API_ORIGIN}/api/:path*` }];
  },
};

export default nextConfig;
