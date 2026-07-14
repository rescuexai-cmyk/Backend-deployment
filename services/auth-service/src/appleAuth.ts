import * as jose from 'jose';
import { createLogger } from '@raahi/shared';

const logger = createLogger('apple-auth');

const APPLE_ISSUER = 'https://appleid.apple.com';
const APPLE_JWKS = jose.createRemoteJWKSet(
  new URL('https://appleid.apple.com/auth/keys'),
);

export interface AppleIdentityPayload {
  sub: string;
  email?: string;
  email_verified?: boolean | string;
  is_private_email?: boolean | string;
  nonce?: string;
  aud: string | string[];
}

function allowedAudiences(): string[] {
  const configured = (process.env.APPLE_CLIENT_ID || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  // Native iOS Sign in with Apple uses the app bundle id as aud.
  const defaults = ['com.rhi.raahi'];
  return Array.from(new Set([...configured, ...defaults]));
}

export async function verifyAppleIdentityToken(
  identityToken: string,
  nonce?: string,
): Promise<AppleIdentityPayload> {
  const audiences = allowedAudiences();
  try {
    const { payload } = await jose.jwtVerify(identityToken, APPLE_JWKS, {
      issuer: APPLE_ISSUER,
      audience: audiences,
    });

    const sub = typeof payload.sub === 'string' ? payload.sub : '';
    if (!sub) {
      throw new Error('Apple token missing subject');
    }

    if (nonce) {
      const tokenNonce = typeof payload.nonce === 'string' ? payload.nonce : '';
      if (!tokenNonce || tokenNonce !== nonce) {
        throw new Error('Apple token nonce mismatch');
      }
    }

    return {
      sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      email_verified: payload.email_verified as boolean | string | undefined,
      is_private_email: payload.is_private_email as boolean | string | undefined,
      nonce: typeof payload.nonce === 'string' ? payload.nonce : undefined,
      aud: payload.aud as string | string[],
    };
  } catch (error: any) {
    logger.error('[APPLE] Identity token verification failed', {
      error: error?.message || String(error),
      audiences,
    });
    throw new Error('Invalid Apple identity token');
  }
}

export function isAppleEmailVerified(payload: AppleIdentityPayload): boolean {
  const v = payload.email_verified;
  return v === true || v === 'true';
}
