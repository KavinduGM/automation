/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: "standalone",
  experimental: {
    // Allow Server Components to bundle our workspace packages.
    serverComponentsExternalPackages: ["@prisma/client", "bullmq", "ioredis"],
  },
  // We're served by Caddy/Traefik at automation.<domain>; trust the proxy.
  poweredByHeader: false,
};
export default nextConfig;
