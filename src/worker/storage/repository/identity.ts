import { nowIso } from "../../utils/dates";
import { newId } from "../../utils/ids";

interface UserRoleHost {
  getUserRole(id: string): Promise<string | null>;
}

export class OwnerTargetProtectedError extends Error {
  constructor() {
    super("Solo un propietario puede modificar a otro propietario");
    this.name = "OwnerTargetProtectedError";
  }
}

export class UserMutationConflictError extends Error {
  constructor() {
    super("El usuario cambió mientras se procesaba la solicitud; vuelva a cargar e intente de nuevo");
    this.name = "UserMutationConflictError";
  }
}

export async function getUserRole(
  db: D1Database,
  id: string
): Promise<string | null> {
  const row = await db
    .prepare("SELECT role FROM users WHERE id = ?")
    .bind(id)
    .first<{ role: string }>();
  return row?.role ?? null;
}

export async function listUsers(
  db: D1Database
): Promise<Array<Record<string, unknown>>> {
  return db
    .prepare("SELECT id, email, name, role, disabled_at, created_at, updated_at FROM users ORDER BY created_at DESC LIMIT 100")
    .all<Record<string, unknown>>()
    .then((result) => result.results ?? []);
}

export async function countUsers(db: D1Database): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS count FROM users")
    .first<{ count: number }>();
  return row?.count ?? 0;
}

export async function createInitialOwner(
  db: D1Database,
  input: {
    email: string;
    name: string;
    passwordHash: string;
    passwordSalt: string;
  }
): Promise<Record<string, unknown> | null> {
  const id = newId("user");
  return db
    .prepare(
      `INSERT INTO users (id, email, name, role, password_hash, password_salt)
         SELECT ?, ?, ?, 'OWNER', ?, ?
          WHERE NOT EXISTS (SELECT 1 FROM users)
         RETURNING id, email, name, role, disabled_at, created_at, updated_at`
    )
    .bind(
      id,
      input.email.toLowerCase(),
      input.name,
      input.passwordHash,
      input.passwordSalt
    )
    .first<Record<string, unknown>>();
}

export async function createUser(
  db: D1Database,
  input: {
    email: string;
    name: string;
    role: string;
    passwordHash: string;
    passwordSalt: string;
  }
): Promise<Record<string, unknown>> {
  const id = newId("user");
  await db
    .prepare("INSERT INTO users (id, email, name, role, password_hash, password_salt) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(
      id,
      input.email.toLowerCase(),
      input.name,
      input.role,
      input.passwordHash,
      input.passwordSalt
    )
    .run();
  const user = await db
    .prepare("SELECT id, email, name, role, disabled_at, created_at, updated_at FROM users WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  if (!user) {
    throw new Error("No se pudo leer el usuario creado");
  }
  return user;
}

export async function getUserForLogin(
  db: D1Database,
  email: string
): Promise<Record<string, string> | null> {
  return db
    .prepare("SELECT id, email, name, role, password_hash, password_salt, disabled_at, auth_generation FROM users WHERE email = ?")
    .bind(email.toLowerCase())
    .first<Record<string, string>>();
}

export async function updateUser(
  db: D1Database,
  host: UserRoleHost,
  id: string,
  input: { role?: string; disabled?: boolean; name?: string; email?: string },
  allowOwnerTarget = false
): Promise<Record<string, unknown>> {
  const existing = await db
    .prepare("SELECT id, email, name, role, disabled_at, auth_generation FROM users WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  if (!existing) {
    throw new Error("Usuario no encontrado");
  }
  const changedAt = nowIso();
  const currentEmail = String(existing.email).toLowerCase();
  const nextEmail = String(input.email ?? existing.email).trim().toLowerCase();
  const wasDisabled = existing.disabled_at != null && existing.disabled_at !== "";
  const willBeDisabled = input.disabled === undefined ? wasDisabled : input.disabled;
  const nextDisabledAt =
    input.disabled === undefined
      ? existing.disabled_at
      : willBeDisabled
        ? changedAt
        : null;
  const invalidatesCapabilities =
    nextEmail !== currentEmail || willBeDisabled !== wasDisabled;
  const observedAuthGeneration = Number(existing.auth_generation ?? 0);
  const nextAuthGeneration =
    observedAuthGeneration + (invalidatesCapabilities ? 1 : 0);

  const update = db
    .prepare(
      `UPDATE users
            SET name = ?, email = ?, role = ?, disabled_at = ?, updated_at = ?,
                auth_generation = auth_generation + ?
          WHERE id = ?
            AND (? = 1 OR role IN ('VIEWER','OPERATOR','ADMIN'))
            AND email = ?
            AND disabled_at IS ?
            AND auth_generation = ?
            AND name = ?
            AND role = ?`
    )
    .bind(
      input.name ?? existing.name,
      nextEmail,
      input.role ?? existing.role,
      nextDisabledAt,
      changedAt,
      invalidatesCapabilities ? 1 : 0,
      id,
      allowOwnerTarget ? 1 : 0,
      currentEmail,
      existing.disabled_at ?? null,
      observedAuthGeneration,
      existing.name,
      existing.role
    );

  if (invalidatesCapabilities) {
    const results = await db.batch([
      update,
      db
        .prepare(
          `UPDATE sessions
                SET revoked_at = ?
              WHERE user_id = ?
                AND revoked_at IS NULL
                AND EXISTS (
                  SELECT 1 FROM users
                   WHERE id = ?
                     AND email = ?
                     AND disabled_at IS ?
                     AND auth_generation = ?
                )`
        )
        .bind(
          changedAt,
          id,
          id,
          nextEmail,
          nextDisabledAt,
          nextAuthGeneration
        ),
      db
        .prepare(
          `UPDATE password_reset_tokens
                SET used_at = ?
              WHERE user_id = ?
                AND used_at IS NULL
                AND EXISTS (
                  SELECT 1 FROM users
                   WHERE id = ?
                     AND email = ?
                     AND disabled_at IS ?
                     AND auth_generation = ?
                )`
        )
        .bind(
          changedAt,
          id,
          id,
          nextEmail,
          nextDisabledAt,
          nextAuthGeneration
        )
    ]);
    if (Number(results[0]?.meta?.changes ?? 0) !== 1) {
      await throwUserMutationFailure(host, id, allowOwnerTarget);
    }
  } else {
    const result = await update.run();
    if (Number(result.meta?.changes ?? 0) !== 1) {
      await throwUserMutationFailure(host, id, allowOwnerTarget);
    }
  }
  const updated = await db
    .prepare("SELECT id, email, name, role, disabled_at, created_at, updated_at FROM users WHERE id = ?")
    .bind(id)
    .first<Record<string, unknown>>();
  if (!updated) {
    throw new Error("No se pudo leer el usuario actualizado");
  }
  return updated;
}

async function throwUserMutationFailure(
  host: UserRoleHost,
  id: string,
  allowOwnerTarget: boolean
): Promise<never> {
  const currentRole = await host.getUserRole(id);
  if (currentRole === null) {
    throw new Error("Usuario no encontrado");
  }
  if (!allowOwnerTarget && currentRole === "OWNER") {
    throw new OwnerTargetProtectedError();
  }
  throw new UserMutationConflictError();
}

export async function createSessionIfCredentialsCurrent(
  db: D1Database,
  input: {
    userId: string;
    expectedPasswordHash: string;
    expectedPasswordSalt: string;
    expectedEmail: string;
    expectedAuthGeneration: number;
    tokenHash: string;
    expiresAt: string;
  }
): Promise<boolean> {
  const id = newId("session");
  const createdAt = nowIso();
  const guard = [
    input.userId,
    input.expectedPasswordHash,
    input.expectedPasswordSalt,
    input.expectedEmail,
    input.expectedAuthGeneration
  ] as const;
  const results = await db.batch([
    db
      .prepare(
        `DELETE FROM sessions
            WHERE user_id = ?
              AND (revoked_at IS NOT NULL OR expires_at <= ?)
              AND EXISTS (
                SELECT 1 FROM users
                 WHERE id = ?
                   AND disabled_at IS NULL
                   AND password_hash = ?
                   AND password_salt = ?
                   AND email = ?
                   AND auth_generation = ?
              )`
      )
      .bind(input.userId, createdAt, ...guard),
    db
      .prepare(
        `DELETE FROM sessions
            WHERE id IN (
              SELECT id FROM sessions
               WHERE user_id = ?
                 AND revoked_at IS NULL
                 AND expires_at > ?
               ORDER BY created_at DESC, id DESC
               LIMIT -1 OFFSET 7
            )
              AND EXISTS (
                SELECT 1 FROM users
                 WHERE id = ?
                   AND disabled_at IS NULL
                   AND password_hash = ?
                   AND password_salt = ?
                   AND email = ?
                   AND auth_generation = ?
              )`
      )
      .bind(input.userId, createdAt, ...guard),
    db
      .prepare(
        `INSERT INTO sessions (
             id, user_id, token_hash, expires_at, created_at
           )
           SELECT ?, id, ?, ?, ?
             FROM users
            WHERE id = ?
              AND disabled_at IS NULL
              AND password_hash = ?
              AND password_salt = ?
              AND email = ?
              AND auth_generation = ?`
      )
      .bind(id, input.tokenHash, input.expiresAt, createdAt, ...guard)
  ]);
  return Number(results[2]?.meta?.changes ?? 0) === 1;
}

export async function getSessionUser(
  db: D1Database,
  tokenHash: string
): Promise<Record<string, string> | null> {
  return db
    .prepare(
      `SELECT users.id, users.email, users.name, users.role
         FROM sessions
         JOIN users ON users.id = sessions.user_id
         WHERE sessions.token_hash = ?
           AND sessions.revoked_at IS NULL
           AND sessions.expires_at > ?
           AND users.disabled_at IS NULL`
    )
    .bind(tokenHash, nowIso())
    .first<Record<string, string>>();
}

export async function revokeSession(
  db: D1Database,
  tokenHash: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE sessions
            SET revoked_at = ?
          WHERE token_hash = ?
            AND revoked_at IS NULL`
    )
    .bind(nowIso(), tokenHash)
    .run();
}

export async function createPasswordResetToken(
  db: D1Database,
  userId: string,
  tokenHash: string,
  expiresAt: string,
  expectedEmail: string,
  expectedAuthGeneration: number,
  expectedPasswordHash: string,
  expectedPasswordSalt: string
): Promise<string | null> {
  const id = newId("reset");
  const issuedAt = nowIso();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE password_reset_tokens
            SET used_at = ?
          WHERE user_id = ?
            AND used_at IS NULL
            AND EXISTS (
              SELECT 1 FROM users
               WHERE id = ? AND disabled_at IS NULL
                 AND email = ? AND auth_generation = ?
                 AND password_hash = ? AND password_salt = ?
            )`
      )
      .bind(
        issuedAt,
        userId,
        userId,
        expectedEmail,
        expectedAuthGeneration,
        expectedPasswordHash,
        expectedPasswordSalt
      ),
    db
      .prepare(
        `INSERT INTO password_reset_tokens (id, user_id, token_hash, expires_at)
         SELECT ?, id, ?, ?
         FROM users
         WHERE id = ? AND disabled_at IS NULL
           AND email = ? AND auth_generation = ?
           AND password_hash = ? AND password_salt = ?`
      )
      .bind(
        id,
        tokenHash,
        expiresAt,
        userId,
        expectedEmail,
        expectedAuthGeneration,
        expectedPasswordHash,
        expectedPasswordSalt
      )
  ]);
  return Number(results[1]?.meta?.changes ?? 0) === 1 ? id : null;
}

export async function invalidatePasswordResetToken(
  db: D1Database,
  id: string
): Promise<void> {
  await db
    .prepare(
      `UPDATE password_reset_tokens
            SET used_at = ?
          WHERE id = ?
            AND used_at IS NULL`
    )
    .bind(nowIso(), id)
    .run();
}

export async function getActivePasswordResetUser(
  db: D1Database,
  tokenHash: string
): Promise<Record<string, string> | null> {
  return db
    .prepare(
      `SELECT users.id, users.email, users.name, users.role, users.id AS user_id, password_reset_tokens.id AS token_id
         FROM password_reset_tokens
         JOIN users ON users.id = password_reset_tokens.user_id
         WHERE password_reset_tokens.token_hash = ?
           AND password_reset_tokens.used_at IS NULL
           AND password_reset_tokens.expires_at > ?
           AND users.disabled_at IS NULL`
    )
    .bind(tokenHash, nowIso())
    .first<Record<string, string>>();
}

export async function resetPasswordWithToken(
  db: D1Database,
  userId: string,
  tokenHash: string,
  passwordHash: string,
  passwordSalt: string
): Promise<boolean> {
  const changedAt = nowIso();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE users
              SET password_hash = ?, password_salt = ?, updated_at = ?
            WHERE id = ?
              AND disabled_at IS NULL
              AND EXISTS (
                SELECT 1
                  FROM password_reset_tokens
                 WHERE user_id = ?
                   AND token_hash = ?
                   AND used_at IS NULL
                   AND expires_at > ?
              )`
      )
      .bind(
        passwordHash,
        passwordSalt,
        changedAt,
        userId,
        userId,
        tokenHash,
        changedAt
      ),
    db
      .prepare(
        `UPDATE sessions
              SET revoked_at = ?
            WHERE user_id = ?
              AND revoked_at IS NULL
              AND EXISTS (
                SELECT 1
                  FROM users
                 WHERE id = ?
                   AND password_hash = ?
                   AND password_salt = ?
                   AND updated_at = ?
              )`
      )
      .bind(changedAt, userId, userId, passwordHash, passwordSalt, changedAt),
    db
      .prepare(
        `UPDATE password_reset_tokens
              SET used_at = ?
            WHERE user_id = ?
              AND used_at IS NULL
              AND EXISTS (
                SELECT 1
                  FROM users
                 WHERE id = ?
                   AND password_hash = ?
                   AND password_salt = ?
                   AND updated_at = ?
              )`
      )
      .bind(changedAt, userId, userId, passwordHash, passwordSalt, changedAt)
  ]);
  return Number(results[0]?.meta?.changes ?? 0) === 1;
}

export async function setUserPassword(
  db: D1Database,
  host: UserRoleHost,
  userId: string,
  passwordHash: string,
  passwordSalt: string,
  allowOwnerTarget = false
): Promise<boolean> {
  const changedAt = nowIso();
  const results = await db.batch([
    db
      .prepare(
        `UPDATE users
              SET password_hash = ?, password_salt = ?, updated_at = ?
            WHERE id = ?
              AND (? = 1 OR role IN ('VIEWER','OPERATOR','ADMIN'))`
      )
      .bind(
        passwordHash,
        passwordSalt,
        changedAt,
        userId,
        allowOwnerTarget ? 1 : 0
      ),
    db
      .prepare(
        `UPDATE sessions
              SET revoked_at = ?
            WHERE user_id = ?
              AND revoked_at IS NULL
              AND EXISTS (
                SELECT 1
                  FROM users
                 WHERE id = ?
                   AND password_hash = ?
                   AND password_salt = ?
                   AND updated_at = ?
              )`
      )
      .bind(changedAt, userId, userId, passwordHash, passwordSalt, changedAt),
    db
      .prepare(
        `UPDATE password_reset_tokens
              SET used_at = ?
            WHERE user_id = ?
              AND used_at IS NULL
              AND EXISTS (
                SELECT 1
                  FROM users
                 WHERE id = ?
                   AND password_hash = ?
                   AND password_salt = ?
                   AND updated_at = ?
              )`
      )
      .bind(changedAt, userId, userId, passwordHash, passwordSalt, changedAt)
  ]);
  const changed = Number(results[0]?.meta?.changes ?? 0) === 1;
  if (
    !changed &&
    !allowOwnerTarget &&
    (await host.getUserRole(userId)) === "OWNER"
  ) {
    throw new OwnerTargetProtectedError();
  }
  return changed;
}

// Opportunistic PBKDF2 rehash on successful login. Unlike setUserPassword this does
// NOT revoke sessions — the credential is unchanged, only its stored encoding. The
// update is compare-and-swap guarded so a stale login cannot overwrite a concurrent
// password reset/change that landed after verification.
export async function updateUserPasswordHashIfCurrent(
  db: D1Database,
  userId: string,
  currentPasswordHash: string,
  currentPasswordSalt: string,
  passwordHash: string,
  passwordSalt: string
): Promise<boolean> {
  const updated = await db
    .prepare(
      `UPDATE users
            SET password_hash = ?, password_salt = ?, updated_at = ?
          WHERE id = ? AND password_hash = ? AND password_salt = ?
          RETURNING id`
    )
    .bind(
      passwordHash,
      passwordSalt,
      nowIso(),
      userId,
      currentPasswordHash,
      currentPasswordSalt
    )
    .first<{ id: string }>();
  return Boolean(updated);
}
