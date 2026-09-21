import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // Uniform response headers across both groups: a header that differed by
  // group would be one more thing a curious participant could diff.
  poweredByHeader: false,

  // Keep the shipped bundle minified with no readable component names, so
  // "which chunk is this" is not answerable from devtools.
  productionBrowserSourceMaps: false,

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
          { key: 'Referrer-Policy', value: 'same-origin' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ]
  },
}

export default nextConfig
