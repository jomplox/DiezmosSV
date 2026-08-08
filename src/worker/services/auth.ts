import { Repository } from "../storage/repository";
import type { Env } from "../types";
import { addDays } from "../utils/dates";
import { base64UrlFromBytes, hexFromBytes, sha256Hex as sha256HexBytes, timingSafeEqual, utf8Bytes } from "../utils/encoding";
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
// Each stage stays within the Workers-compatible PBKDF2 ceiling. Current hashes use
// two domain-separated stages, while legacy verification pads its first-stage compare
// with the same second stage so account state does not change invalid-login KDF work.
const PASSWORD_PBKDF2_ITERATIONS = 100_000;
const PASSWORD_HASH_LEGACY_SCHEME = "pbkdf2";
const PASSWORD_HASH_CHAIN_SCHEME = "pbkdf2-chain-v1";
const PASSWORD_HASH_TRANSITIONAL_CHAIN_SCHEME = "pbkdf2-chain";
const PASSWORD_CHAIN_SALT_SUFFIX = ":diezmossv-pbkdf2-chain-v1";
const PASSWORD_HASH_HEX_PATTERN = /^[0-9a-f]{64}$/;
const DUMMY_PASSWORD_SALT = "diezmossv-login-dummy-v1";
// Golden vector for "diezmossv-login-dummy-password-v1" at DUMMY_PASSWORD_SALT.
// The submitted password is still derived for missing/disabled accounts; this record
// supplies a valid current-format comparison target without carrying a real credential.
const DUMMY_PASSWORD_RAW_HASH = "1368814a801077a2ccf4976bdedac3410ffb14c6c3193bbbdf203c6ae0c277db";
const DUMMY_PASSWORD_HASH = `${PASSWORD_HASH_CHAIN_SCHEME}$${PASSWORD_PBKDF2_ITERATIONS}$${DUMMY_PASSWORD_RAW_HASH}`;
export const PASSWORD_RESET_TTL_MINUTES = 45;

export class PasswordResetError extends Error {}
export class PasswordPolicyError extends Error {}
export class UserNotFoundError extends Error {}
export class BootstrapUnavailableError extends Error {}

export class AuthService {
  private readonly repo: Repository;

  constructor(env: Env) {
    this.repo = new Repository(env.DB);
  }

  async bootstrapOwner(input: { email: string; name: string; password: string }): Promise<AuthUser> {
    const hashed = await hashForStorage(input.password);
    const user = await this.repo.createInitialOwner({
      email: input.email,
      name: input.name,
      passwordHash: hashed.hash,
      passwordSalt: hashed.salt
    });
    if (!user) {
      throw new BootstrapUnavailableError("La creación del propietario inicial ya no está disponible");
    }
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
      await verifyPassword(password, DUMMY_PASSWORD_SALT, DUMMY_PASSWORD_HASH);
      throw invalidCredentialsError();
    }
    const verified = await verifyPassword(password, row.password_salt, row.password_hash);
    if (!verified.valid) {
      throw invalidCredentialsError();
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
        throw invalidCredentialsError();
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
      expectedEmail: row.email,
      expectedAuthGeneration: Number(row.auth_generation ?? 0),
      tokenHash: await sha256HexBytes(utf8Bytes(token)),
      expiresAt
    });
    if (!created) {
      throw invalidCredentialsError();
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
    const tokenId = await this.repo.createPasswordResetToken(
      row.id,
      await sha256HexBytes(utf8Bytes(token)),
      expiresAt,
      row.email,
      Number(row.auth_generation ?? 0),
      row.password_hash,
      row.password_salt
    );
    if (!tokenId) {
      return null;
    }
    return { user: publicUser(row), token, tokenId, expiresAt };
  }

  async confirmPasswordReset(token: string, password: string): Promise<AuthUser> {
    const trimmed = token.trim();
    const tokenHash = trimmed ? await sha256HexBytes(utf8Bytes(trimmed)) : "";
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
    const tokenHash = await sha256HexBytes(utf8Bytes(header.slice("Bearer ".length).trim()));
    const row = await this.repo.getSessionUser(tokenHash);
    return row ? publicUser(row) : null;
  }

  async logout(request: Request): Promise<void> {
    const header = request.headers.get("Authorization");
    const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
    if (!token) {
      throw new AuthError("Debe iniciar sesión", 401);
    }
    await this.repo.revokeSession(await sha256HexBytes(utf8Bytes(token)));
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

function invalidCredentialsError(): AuthError {
  return new AuthError("Credenciales inválidas", 401);
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
  const iterations = options.iterations ?? PASSWORD_PBKDF2_ITERATIONS;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > PASSWORD_PBKDF2_ITERATIONS) {
    throw new RangeError("PBKDF2 iteration count is outside the Workers-compatible range");
  }
  const effectiveSalt = salt ?? base64UrlFromBytes(crypto.getRandomValues(new Uint8Array(16)));
  const key = await crypto.subtle.importKey("raw", utf8Bytes(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: utf8Bytes(effectiveSalt),
      iterations,
      hash: "SHA-256"
    },
    key,
    256
  );
  return { hash: hexFromBytes(new Uint8Array(bits)), salt: effectiveSalt };
}

async function deriveFirst(password: string, salt: string): Promise<{ hash: string; salt: string }> {
  return hashPassword(password, salt, {
    enforcePolicy: false,
    iterations: PASSWORD_PBKDF2_ITERATIONS
  });
}

async function deriveSecond(firstHash: string, salt: string): Promise<{ hash: string; salt: string }> {
  return hashPassword(firstHash, `${salt}${PASSWORD_CHAIN_SALT_SUFFIX}`, {
    enforcePolicy: false,
    iterations: PASSWORD_PBKDF2_ITERATIONS
  });
}

// Derives a password at the current work factor and returns it in the versioned stored
// format. Used everywhere a password is written (create/bootstrap/reset/rehash).
export async function hashForStorage(password: string, options: { enforcePolicy?: boolean } = {}): Promise<{ hash: string; salt: string }> {
  const first = await hashPassword(password, undefined, {
    enforcePolicy: options.enforcePolicy ?? true,
    iterations: PASSWORD_PBKDF2_ITERATIONS
  });
  const second = await deriveSecond(first.hash, first.salt);
  return {
    hash: `${PASSWORD_HASH_CHAIN_SCHEME}$${PASSWORD_PBKDF2_ITERATIONS}$${second.hash}`,
    salt: first.salt
  };
}

type ParsedPasswordHash =
  | { kind: "current-chain"; hash: string }
  | { kind: "transitional-chain"; hash: string }
  | { kind: "legacy-versioned"; hash: string }
  | { kind: "legacy-countless"; hash: string }
  | { kind: "invalid" };

function parseStoredHash(stored: unknown): ParsedPasswordHash {
  if (typeof stored !== "string") {
    return { kind: "invalid" };
  }
  if (PASSWORD_HASH_HEX_PATTERN.test(stored)) {
    return { kind: "legacy-countless", hash: stored };
  }

  const [scheme, count, hash, extra] = stored.split("$");
  if (extra !== undefined || count !== String(PASSWORD_PBKDF2_ITERATIONS) || !PASSWORD_HASH_HEX_PATTERN.test(hash ?? "")) {
    return { kind: "invalid" };
  }
  if (scheme === PASSWORD_HASH_CHAIN_SCHEME) {
    return { kind: "current-chain", hash };
  }
  if (scheme === PASSWORD_HASH_TRANSITIONAL_CHAIN_SCHEME) {
    return { kind: "transitional-chain", hash };
  }
  if (scheme === PASSWORD_HASH_LEGACY_SCHEME) {
    return { kind: "legacy-versioned", hash };
  }
  return { kind: "invalid" };
}

// Every path performs exactly two fixed-count derivations. In particular, no iteration
// count read from D1 is ever passed into WebCrypto.
async function verifyPassword(password: string, salt: string, storedHash: unknown): Promise<{ valid: boolean; needsRehash: boolean }> {
  const parsed = parseStoredHash(storedHash);
  if (parsed.kind === "current-chain" || parsed.kind === "transitional-chain") {
    const first = await deriveFirst(password, salt);
    const second = await deriveSecond(first.hash, salt);
    const valid = timingSafeEqual(second.hash, parsed.hash);
    return {
      valid,
      needsRehash: valid && parsed.kind === "transitional-chain"
    };
  }

  if (parsed.kind === "legacy-versioned" || parsed.kind === "legacy-countless") {
    const first = await deriveFirst(password, salt);
    const valid = timingSafeEqual(first.hash, parsed.hash);
    await deriveSecond(first.hash, salt);
    return { valid, needsRehash: valid };
  }

  const first = await deriveFirst(password, DUMMY_PASSWORD_SALT);
  const second = await deriveSecond(first.hash, DUMMY_PASSWORD_SALT);
  timingSafeEqual(second.hash, DUMMY_PASSWORD_RAW_HASH);
  return { valid: false, needsRehash: false };
}

function publicUser(row: Record<string, unknown>): AuthUser {
  return {
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    role: String(row.role) as Role
  };
}
