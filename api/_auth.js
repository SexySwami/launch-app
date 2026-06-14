// Shared JWT verification helper for Vercel Edge Functions.
// Verifies the Clerk Bearer token from the Authorization header and returns
// the user's Clerk ID (sub claim), or null if missing / invalid.

import { verifyToken } from '@clerk/backend';

export async function getUserId(request) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  if (!token) return null;
  try {
    const payload = await verifyToken(token, {
      secretKey: process.env.CLERK_SECRET_KEY,
    });
    return payload.sub || null;
  } catch {
    return null;
  }
}
