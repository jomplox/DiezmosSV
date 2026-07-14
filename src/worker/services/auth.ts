import { Repository } from "../storage/repository";
import type { Env } from "../types";
import { addDays } from "../utils/dates";
import { base64UrlFromBytes, hexFromBytes, timingSafeEqual, utf8Bytes } from "../utils/encoding";
import { passwordPolicyError } from "../../shared/passwordPolicy";

export type Role = "VIEWER" | "OPERATOR" | "ADMIN" | "OWNER";

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

const ROLE_RANK: Record<Role, number> = {
  VIEWER: 1,
  OPERATOR: 2,
  ADMIN: 3,
  OWNER: 4
};
// Current PBKDF2 work factor. Cloudflare Workers rejects counts above 100k, so the
// versioned storage format keeps the count explicit without asking workerd for an
// unsupported derivation.
const PASSWORD_PBKDF2_ITERATIONS = 100_000;
// Historic counts used by pre-versioning ("countless") rows. The surviving staging
// owners were bootstrapped at the current Workers-compatible count, so no additional
// deployed fallback count is safe to try.
const LEGACY_PASSWORD_PBKDF2_ITERATIONS: number[] = [];
const PASSWORD_HASH_SCHEME = "pbkdf2";
export const PASSWORD_RESET_TTL_MINUTES = 45;

export class PasswordResetError extends Error {}
export class PasswordPolicyError extends Error {}
export class UserNotFoundError extends Error {}

export class AuthService {
  private readonly repo: Repository;

  constructor(env: Env) {
    this.repo = new Repository(env.DB);
  }

  async bootstrapOwner(input: { email: string; name: string; password: string }): Promise<AuthUser> {
    const count = await this.repo.countUsers();
    if (count > 0) {
      throw new Error("La creación del propietario inicial solo está disponible antes de que exista el primer usuario");
    }
    const hashed = await hashForStorage(input.password);
    const user = await this.repo.createUser({
      email: input.email,
      name: input.name,
      role: "OWNER",
      passwordHash: hashed.hash,
      passwordSalt: hashed.salt
    });
    return publicUser(user);
  }

  async createUser(input: { email: string; name: string; role: Role; password: string }): Promise<AuthUser> {
    const hashed = await hashForStorage(input.password);
    const user = await this.repo.createUser({
      email: input.email,
      name: input.name,
      role: input.role,
      passwordHash: hashed.hash,
      passwordSalt: hashed.salt
    });
    return publicUser(user);
  }

  async resetUserPassword(userId: string, password: string, allowOwnerTarget = false): Promise<void> {
    const hashed = await hashForStorage(password);
    if (!(await this.repo.setUserPassword(userId, hashed.hash, hashed.salt, allowOwnerTarget))) {
      throw new UserNotFoundError("Usuario no encontrado");
    }
  }

  async login(email: string, password: string): Promise<{ user: AuthUser; token: string; expiresAt: string }> {
    const row = await this.repo.getUserForLogin(email);
    if (!row || row.disabled_at) {
      throw new Error("Credenciales inválidas");
    }
    const verified = await verifyPassword(password, row.password_salt, row.password_hash);
    if (!verified.valid) {
      throw new Error("Credenciales inválidas");
    }
    let expectedPasswordHash = row.password_hash;
    let expectedPasswordSalt = row.password_salt;
    if (verified.needsRehash) {
      // Verify-then-upgrade: rehash the just-proven password into the current versioned
      // format. No policy check — an existing password may predate the current policy.
      const upgraded = await hashForStorage(password, { enforcePolicy: false });
      const upgradedCurrentRow = await this.repo.updateUserPasswordHashIfCurrent(
        row.id,
        row.password_hash,
        row.password_salt,
        upgraded.hash,
        upgraded.salt
      );
      if (!upgradedCurrentRow) {
        // The password row changed after verification (for example, a concurrent
        // reset). Do not create a session for a credential that may no longer be
        // current.
        throw new Error("Credenciales inválidas");
      }
      expectedPasswordHash = upgraded.hash;
      expectedPasswordSalt = upgraded.salt;
    }
    const token = base64UrlFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = addDays(new Date().toISOString(), 1);
    const created = await this.repo.createSessionIfCredentialsCurrent({
      userId: row.id,
      expectedPasswordHash,
      expectedPasswordSalt,
      tokenHash: await sha256Hex(token),
      expiresAt
    });
    if (!created) {
      throw new Error("Credenciales inválidas");
    }
    return { user: publicUser(row), token, expiresAt };
  }

  async createPasswordResetToken(email: string): Promise<{ user: AuthUser; token: string; tokenId: string; expiresAt: string } | null> {
    const row = await this.repo.getUserForLogin(email);
    if (!row || row.disabled_at) {
      return null;
    }
    const token = base64UrlFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MINUTES * 60_000).toISOString();
    const tokenId = await this.repo.createPasswordResetToken(row.id, await sha256Hex(token), expiresAt);
    return { user: publicUser(row), token, tokenId, expiresAt };
  }

  async confirmPasswordReset(token: string, password: string): Promise<AuthUser> {
    const trimmed = token.trim();
    const tokenHash = trimmed ? await sha256Hex(trimmed) : "";
    const row = tokenHash ? await this.repo.getActivePasswordResetUser(tokenHash) : null;
    if (!row) {
      throw new PasswordResetError("El enlace de restablecimiento no es válido o ya expiró. Solicite uno nuevo.");
    }
    const hashed = await hashForStorage(password);
    const changed = await this.repo.resetPasswordWithToken(String(row.user_id), tokenHash, hashed.hash, hashed.salt);
    if (!changed) {
      throw new PasswordResetError("El enlace de restablecimiento no es válido o ya expiró. Solicite uno nuevo.");
    }
    return publicUser(row);
  }

  async authenticate(request: Request): Promise<AuthUser | null> {
    const header = request.headers.get("Authorization");
    if (!header?.startsWith("Bearer ")) {
      return null;
    }
    const tokenHash = await sha256Hex(header.slice("Bearer ".length).trim());
    const row = await this.repo.getSessionUser(tokenHash);
    return row ? publicUser(row) : null;
  }

  async logout(request: Request): Promise<void> {
    const header = request.headers.get("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token) {
      throw new AuthError("Debe iniciar sesión", 401);
    }
    await this.repo.revokeSession(await sha256Hex(token));
  }
}

export function requireRole(user: AuthUser | null, role: Role): AuthUser {
  if (!user) {
    throw new AuthError("Debe iniciar sesión", 401);
  }
  if (ROLE_RANK[user.role] < ROLE_RANK[role]) {
    throw new AuthError("Su usuario no tiene permisos suficientes", 403);
  }
  return user;
}

export class AuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function hashPassword(
  password: string,
  salt?: string,
  options: { enforcePolicy?: boolean; iterations?: number } = {}
): Promise<{ hash: string; salt: string }> {
  if (options.enforcePolicy ?? true) {
    const policyError = passwordPolicyError(password);
    if (policyError) {
      throw new PasswordPolicyError(policyError);
    }
  }
  const effectiveSalt = salt ?? base64UrlFromBytes(crypto.getRandomValues(new Uint8Array(16)));
  const key = await crypto.subtle.importKey("raw", utf8Bytes(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: utf8Bytes(effectiveSalt),
      iterations: options.iterations ?? PASSWORD_PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    key,
    256
  );
  return { hash: hexFromBytes(new Uint8Array(bits)), salt: effectiveSalt };
}

// Derives a password at the current work factor and returns it in the versioned stored
// format. Used everywhere a password is written (create/bootstrap/reset/rehash).
async function hashForStorage(password: string, options: { enforcePolicy?: boolean } = {}): Promise<{ hash: string; salt: string }> {
  const derived = await hashPassword(password, undefined, {
    enforcePolicy: options.enforcePolicy ?? true,
    iterations: PASSWORD_PBKDF2_ITERATIONS
  });
  return { hash: `${PASSWORD_HASH_SCHEME}$${PASSWORD_PBKDF2_ITERATIONS}$${derived.hash}`, salt: derived.salt };
}

// Splits a stored hash into its iteration count and raw hex. A value without the
// `pbkdf2$<n>$` marker is a pre-versioning (countless) hash and reports iterations=null.
function parseStoredHash(stored: string): { iterations: number | null; hash: string } {
  const parts = stored.split("$");
  if (parts.length === 3 && parts[0] === PASSWORD_HASH_SCHEME) {
    const iterations = Number(parts[1]);
    if (Number.isInteger(iterations) && iterations > 0) {
      return { iterations, hash: parts[2] };
    }
  }
  return { iterations: null, hash: stored };
}

// Verifies a password against a stored hash, honouring an embedded iteration count and
// falling back to the historic legacy counts for countless hashes. needsRehash signals
// that a successful match should be re-stored at the current work factor/format.
async function verifyPassword(password: string, salt: string, storedHash: string): Promise<{ valid: boolean; needsRehash: boolean }> {
  const parsed = parseStoredHash(storedHash);
  if (parsed.iterations !== null) {
    const computed = await hashPassword(password, salt, { enforcePolicy: false, iterations: parsed.iterations });
    if (timingSafeEqual(computed.hash, parsed.hash)) {
      return { valid: true, needsRehash: parsed.iterations !== PASSWORD_PBKDF2_ITERATIONS };
    }
    return { valid: false, needsRehash: false };
  }
  for (const iterations of [PASSWORD_PBKDF2_ITERATIONS, ...LEGACY_PASSWORD_PBKDF2_ITERATIONS]) {
    const computed = await hashPassword(password, salt, { enforcePolicy: false, iterations });
    if (timingSafeEqual(computed.hash, parsed.hash)) {
      // Countless hashes always upgrade so they gain an explicit iteration marker.
      return { valid: true, needsRehash: true };
    }
  }
  return { valid: false, needsRehash: false };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", utf8Bytes(value));
  return hexFromBytes(new Uint8Array(digest));
}

function publicUser(row: Record<string, unknown>): AuthUser {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    role: String(row.role) as Role
  };
}
