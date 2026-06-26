import { Repository } from "../storage/repository";
import type { Env } from "../types";
import { addDays } from "../utils/dates";
import { base64UrlFromBytes, hexFromBytes, timingSafeEqual, utf8Bytes } from "../utils/encoding";

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
const PASSWORD_PBKDF2_ITERATIONS = 100_000;

export class AuthService {
  private readonly repo: Repository;

  constructor(env: Env) {
    this.repo = new Repository(env.DB);
  }

  async bootstrapOwner(input: { email: string; name: string; password: string }): Promise<AuthUser> {
    const count = await this.repo.countUsers();
    if (count > 0) {
      throw new Error("Owner bootstrap is only available before the first user exists");
    }
    const hashed = await hashPassword(input.password);
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
    const hashed = await hashPassword(input.password);
    const user = await this.repo.createUser({
      email: input.email,
      name: input.name,
      role: input.role,
      passwordHash: hashed.hash,
      passwordSalt: hashed.salt
    });
    return publicUser(user);
  }

  async login(email: string, password: string): Promise<{ user: AuthUser; token: string; expiresAt: string }> {
    const row = await this.repo.getUserForLogin(email);
    if (!row || row.disabled_at) {
      throw new Error("Invalid credentials");
    }
    const computed = await hashPassword(password, row.password_salt);
    if (!timingSafeEqual(computed.hash, row.password_hash)) {
      throw new Error("Invalid credentials");
    }
    const token = base64UrlFromBytes(crypto.getRandomValues(new Uint8Array(32)));
    const expiresAt = addDays(new Date().toISOString(), 1);
    await this.repo.createSession(row.id, await sha256Hex(token), expiresAt);
    return { user: publicUser(row), token, expiresAt };
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
}

export function requireRole(user: AuthUser | null, role: Role): AuthUser {
  if (!user) {
    throw new AuthError("Authentication required", 401);
  }
  if (ROLE_RANK[user.role] < ROLE_RANK[role]) {
    throw new AuthError("Insufficient role", 403);
  }
  return user;
}

export class AuthError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function hashPassword(password: string, salt?: string): Promise<{ hash: string; salt: string }> {
  if (password.length < 10) {
    throw new Error("Password must be at least 10 characters");
  }
  const effectiveSalt = salt ?? base64UrlFromBytes(crypto.getRandomValues(new Uint8Array(16)));
  const key = await crypto.subtle.importKey("raw", utf8Bytes(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: utf8Bytes(effectiveSalt),
      iterations: PASSWORD_PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    key,
    256
  );
  return { hash: hexFromBytes(new Uint8Array(bits)), salt: effectiveSalt };
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
