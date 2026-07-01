/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return {
      beforeFiles: [
        {
          source: '/api/public/:path*',
          destination: '/app/api/public/:path*',
        },
        {
          source: '/functions/v1/:path*',
          destination: '/app/functions/v1/:path*',
        },
      ],
    };
  },
};

module.exports = nextConfig;
