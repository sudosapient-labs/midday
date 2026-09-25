import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

export type Session = {
  user: {
    id: string;
    email?: string;
    full_name?: string;
  };
  teamId?: string;
};

type SupabaseJWTPayload = JWTPayload & {
  role?: string;
  // Supabase puts email on the top-level JWT claim for email/OTP sign-in.
  // OAuth providers often also mirror it under user_metadata.
  email?: string;
  user_metadata?: {
    email?: string;
    full_name?: string;
    name?: string;
    [key: string]: string | undefined;
  };
};

function readStringClaim(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

if (!process.env.SUPABASE_URL) {
  throw new Error("SUPABASE_URL is required to verify access tokens");
}

// Supabase signs tokens with the browser-facing auth URL as `iss`. In a local
// container deployment the API reaches Supabase over Docker networking, while
// tokens still carry the host URL (for example http://127.0.0.1:54321/auth/v1).
// Keep those concerns separate rather than weakening issuer verification.
const ISSUER =
  process.env.SUPABASE_AUTH_ISSUER ??
  `${process.env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1`;

const JWKS_URL = `${process.env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/.well-known/jwks.json`;

// Verify via JWKS only (asymmetric ES256/RS256). jose caches the keyset in
// memory so only the first call hits the network. There is deliberately no
// HS256 shared-secret fallback: SUPABASE_JWT_SECRET is a symmetric key that
// anyone who can read it can also *sign* with, so accepting HS256 here would
// turn a leaked secret into full token forgery for any `sub`.
const JWKS = createRemoteJWKSet(new URL(JWKS_URL));

function extractSession(payload: JWTPayload): Session | null {
  const p = payload as SupabaseJWTPayload;

  // `sub` is the user id. Without it there is no identity to act as.
  if (typeof p.sub !== "string" || p.sub.length === 0) {
    return null;
  }

  // Reject anon/service tokens: only end-user sessions may act as a user.
  if (p.role !== "authenticated") {
    return null;
  }

  return {
    user: {
      id: p.sub,
      // Prefer top-level email (email/OTP magic-link tokens), then metadata.
      email:
        readStringClaim(p.email) ?? readStringClaim(p.user_metadata?.email),
      full_name:
        readStringClaim(p.user_metadata?.full_name) ??
        readStringClaim(p.user_metadata?.name),
    },
  };
}

export async function verifyAccessToken(
  accessToken?: string,
): Promise<Session | null> {
  if (!accessToken) return null;

  try {
    const { payload } = await jwtVerify(accessToken, JWKS, {
      issuer: ISSUER,
      audience: "authenticated",
      algorithms: ["RS256", "ES256"],
    });
    return extractSession(payload);
  } catch {
    return null;
  }
}
