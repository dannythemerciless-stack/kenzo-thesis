import type { MetadataRoute } from 'next'

/**
 * A leaked, search-indexed question bank would ruin the instrument.
 * Paired with the X-Robots-Tag header in next.config.ts.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [{ userAgent: '*', disallow: '/' }],
  }
}
