import { hash, verify } from '@node-rs/argon2';

/**
 * Password hashing with argon2id (OWASP-recommended). Parameters are sane
 * defaults; tune memoryCost upward as production hardware allows.
 */
const OPTS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  outputLen: 32,
  parallelism: 1,
} as const;

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTS);
}

export function verifyPassword(digest: string, plain: string): Promise<boolean> {
  return verify(digest, plain, OPTS);
}
