import type { NextConfig } from 'next';
import { createRequire } from 'node:module';
import path from 'node:path';
const require = createRequire(import.meta.url);
// Absolute path to the browser (ESM) build — the package's exports map does not expose it by sub-path.
const humanBrowserBuild = path.join(path.dirname(require.resolve('@vladmandic/human')), 'human.esm.js');
const nextConfig: NextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@burtplace/types'],
  output: 'standalone',
  // @vladmandic/human resolves to its Node build (tfjs-node native addon) under the "node" export condition. The face
  // client only ever imports it in the browser, so keep it out of the server bundle and pin the browser build for clients.
  serverExternalPackages: ['@vladmandic/human', '@tensorflow/tfjs-node'],
  webpack(config, { isServer }) {
    if (!isServer) config.resolve.alias = { ...config.resolve.alias, '@vladmandic/human': humanBrowserBuild };
    return config;
  },
  async rewrites() {
    // Proxy API calls through the web origin in production-like setups (keeps tokens off third-party origins).
    const api = process.env.API_INTERNAL_URL ?? process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
    return [{ source: '/api/v1/:path*', destination: `${api}/api/v1/:path*` }];
  },
};
export default nextConfig;
