import type { NextConfig } from 'next';
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@burtplace/types'],
  output: 'standalone',
  async rewrites() {
    // Proxy API calls through the web origin in production-like setups (keeps tokens off third-party origins).
    const api = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
    return [{ source: '/api/v1/:path*', destination: `${api}/api/v1/:path*` }];
  },
};
export default nextConfig;
