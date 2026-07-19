import { newId } from "../../utils/ids";

export async function claimDonationIntentRateLimit(
  db: D1Database,
  keyHash: string,
  clientIp: string,
  now: string,
  cutoff: string,
  expiresAt: string,
  limit: number
): Promise<string | null> {
  // Unattributed rows are legacy activity, including old-version requests that
  // finish after the first new claim. New-version rows carry their claim id.
  const id = newId("rate");
  const row = await db
    .prepare(
      `INSERT INTO security_rate_limit_claims (
           id, scope, key_hash, claimed_at, expires_at
         )
         SELECT ?, 'donation_intent', ?, ?, ?
          WHERE (
            (
              SELECT COUNT(*)
                FROM security_rate_limit_claims
               WHERE scope = 'donation_intent'
                 AND key_hash = ?
                 AND claimed_at >= ?
            ) + (
              SELECT COUNT(*)
               FROM donation_intents
               WHERE client_ip = ?
                 AND created_at >= ?
                 AND rate_limit_claim_id IS NULL
            )
          ) < ?
         RETURNING id`
    )
    .bind(id, keyHash, now, expiresAt, keyHash, cutoff, clientIp, cutoff, limit)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function claimDonationDatosRateLimit(
  db: D1Database,
  keyHash: string,
  now: string,
  cutoff: string,
  expiresAt: string,
  limit: number
): Promise<string | null> {
  const id = newId("rate");
  const row = await db
    .prepare(
      `INSERT INTO security_rate_limit_claims (
           id, scope, key_hash, claimed_at, expires_at
         )
         SELECT ?, 'donation_datos', ?, ?, ?
          WHERE (
            SELECT COUNT(*)
              FROM security_rate_limit_claims
             WHERE scope = 'donation_datos'
               AND key_hash = ?
               AND claimed_at >= ?
          ) < ?
         RETURNING id`
    )
    .bind(id, keyHash, now, expiresAt, keyHash, cutoff, limit)
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function claimPasswordResetBudgets(
  db: D1Database,
  pairKeyHash: string,
  accountKeyHash: string,
  accountId: string,
  now: string,
  cutoff: string,
  expiresAt: string,
  pairLimit: number,
  accountLimit: number
): Promise<string | null> {
  const id = newId("rate");
  const row = await db
    .prepare(
      `INSERT INTO security_rate_limit_claims (
           id, scope, key_hash, subject_key_hash, claimed_at, expires_at
         )
         SELECT ?, 'password_reset', ?, ?, ?, ?
          WHERE (
            SELECT COUNT(*)
              FROM security_rate_limit_claims
             WHERE scope = 'password_reset'
               AND key_hash = ?
               AND claimed_at >= ?
          ) < ?
            AND (
              (
                SELECT COUNT(*)
                  FROM security_rate_limit_claims
                 WHERE scope = 'password_reset'
                   AND subject_key_hash = ?
                   AND claimed_at >= ?
              ) + (
                SELECT COUNT(*)
                  FROM audit_logs AS audit
                  LEFT JOIN security_rate_limit_claims AS legacy_claim
                    ON legacy_claim.id = audit.rate_limit_claim_id
                 WHERE audit.entity_id = ?
                   AND audit.action IN ('PASSWORD_RESET_REQUESTED', 'PASSWORD_RESET_EMAIL_FAILED')
                   AND audit.created_at >= ?
                   AND (
                     audit.rate_limit_claim_id IS NULL
                     OR legacy_claim.subject_key_hash IS NULL
                   )
              )
            ) < ?
         RETURNING id`
    )
    .bind(
      id,
      pairKeyHash,
      accountKeyHash,
      now,
      expiresAt,
      pairKeyHash,
      cutoff,
      pairLimit,
      accountKeyHash,
      cutoff,
      accountId,
      cutoff,
      accountLimit
    )
    .first<{ id: string }>();
  return row?.id ?? null;
}

export async function claimLoginAttempt(
  db: D1Database,
  keyHash: string,
  now: string,
  cutoff: string,
  expiresAt: string,
  limit: number
): Promise<boolean> {
  const row = await db
    .prepare(
      `INSERT INTO login_rate_limits (
           key_hash, window_started_at, attempt_count, expires_at
         ) VALUES (?, ?, 1, ?)
         ON CONFLICT(key_hash) DO UPDATE SET
           window_started_at = CASE
             WHEN login_rate_limits.window_started_at <= ?
               THEN excluded.window_started_at
             ELSE login_rate_limits.window_started_at
           END,
           attempt_count = CASE
             WHEN login_rate_limits.window_started_at <= ?
               THEN 1
             ELSE login_rate_limits.attempt_count + 1
           END,
           expires_at = CASE
             WHEN login_rate_limits.window_started_at <= ?
               THEN excluded.expires_at
             ELSE login_rate_limits.expires_at
           END
         WHERE login_rate_limits.window_started_at <= ?
            OR login_rate_limits.attempt_count < ?
         RETURNING attempt_count`
    )
    .bind(keyHash, now, expiresAt, cutoff, cutoff, cutoff, cutoff, limit)
    .first<{ attempt_count: number }>();
  return row !== null;
}

export async function deleteExpiredLoginRateLimits(
  db: D1Database,
  now: string
): Promise<void> {
  await db
    .prepare("DELETE FROM login_rate_limits WHERE expires_at <= ?")
    .bind(now)
    .run();
}

export async function deleteExpiredSecurityRateLimitClaims(
  db: D1Database,
  now: string
): Promise<void> {
  await db
    .prepare("DELETE FROM security_rate_limit_claims WHERE expires_at <= ?")
    .bind(now)
    .run();
}
