import type { MetadataRoute } from 'next';

/** A private library: no page is for a crawler (the layout says noindex too). */
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', disallow: '/' } };
}
