import { newId } from "../../utils/ids";

export type StripeProviderRecoveryClaim =
  | { kind: "CLAIMED"; id: string }
  | { kind: "IN_PROGRESS" }
  | { kind: "LIMITED" };

export type ProviderCreationClaim =
  | { kind: "CLAIMED"; id: string }
  | { kind: "DUPLICATE"; id: string }
  | { kind: "LIMITED" };

export async function claimProviderCreationBudget(
  db: D1Database,
  input: {
    provider: "WOMPI" | "STRIPE";
    clientKeyHash: string;
    stripeRequestId: string | null;
    now: string;
    cutoff: string;
    expiresAt: string;
    clientLimit: number;
    providerLimit: number;
    globalLimit: number;
  }
): Promise<ProviderCreationClaim> {
  const id = newId("provider_create");
  // One statement owns all three rolling count decisions. During a rolling
  // deploy, recent parent rows without a provider claim remain attributed to
  // their provider/global budgets; attached rows are represented by the claim
  // itself and are deliberately not double-counted.
  const row = await db.prepare(
    `INSERT INTO provider_creation_claims (
       id, provider, client_key_hash, stripe_request_id, claimed_at, expires_at
     )
     SELECT ?, ?, ?, ?, ?, ?
      WHERE (
        SELECT COUNT(*) FROM provider_creation_claims
         WHERE client_key_hash = ? AND claimed_at >= ?
           AND (provider <> 'STRIPE' OR stripe_request_id IS NOT ?)
      ) < ?
        AND (
          (SELECT COUNT(*) FROM provider_creation_claims
            WHERE provider = ? AND claimed_at >= ?
              AND (provider <> 'STRIPE' OR stripe_request_id IS NOT ?))
          + CASE WHEN ? = 'WOMPI'
              THEN (SELECT COUNT(*) FROM donation_intents
                     WHERE provider_creation_claim_id IS NULL AND created_at >= ?)
              ELSE (SELECT COUNT(*) FROM stripe_checkout_sessions
                     WHERE provider_creation_claim_id IS NULL AND created_at >= ?)
            END
        ) < ?
        AND (
          (SELECT COUNT(*) FROM provider_creation_claims
            WHERE claimed_at >= ?
              AND (provider <> 'STRIPE' OR stripe_request_id IS NOT ?))
          + (SELECT COUNT(*) FROM donation_intents
             WHERE provider_creation_claim_id IS NULL AND created_at >= ?)
          + (SELECT COUNT(*) FROM stripe_checkout_sessions
             WHERE provider_creation_claim_id IS NULL AND created_at >= ?)
        ) < ?
     ON CONFLICT(provider, stripe_request_id)
       WHERE provider = 'STRIPE' AND stripe_request_id IS NOT NULL
     DO UPDATE SET
       client_key_hash = excluded.client_key_hash,
       claimed_at = excluded.claimed_at,
       expires_at = excluded.expires_at
     WHERE provider_creation_claims.expires_at <= excluded.claimed_at
     RETURNING id`
  ).bind(
    id,
    input.provider,
    input.clientKeyHash,
    input.stripeRequestId,
    input.now,
    input.expiresAt,
    input.clientKeyHash,
    input.cutoff,
    input.stripeRequestId,
    input.clientLimit,
    input.provider,
    input.cutoff,
    input.stripeRequestId,
    input.provider,
    input.cutoff,
    input.cutoff,
    input.providerLimit,
    input.cutoff,
    input.stripeRequestId,
    input.cutoff,
    input.cutoff,
    input.globalLimit
  ).first<{ id: string }>();
  if (row) return { kind: "CLAIMED", id: row.id };
  if (input.provider === "STRIPE" && input.stripeRequestId) {
    const duplicate = await db.prepare(
      `SELECT id FROM provider_creation_claims
        WHERE provider = 'STRIPE' AND stripe_request_id = ?
          AND claimed_at >= ? AND expires_at > ?
        LIMIT 1`
    ).bind(input.stripeRequestId, input.cutoff, input.now).first<{ id: string }>();
    if (duplicate) return { kind: "DUPLICATE", id: duplicate.id };
  }
  return { kind: "LIMITED" };
}

export async function releaseUnusedProviderCreationClaim(
  db: D1Database,
  id: string
): Promise<void> {
  await db.prepare(
    `DELETE FROM provider_creation_claims
      WHERE id = ?
        AND NOT EXISTS (
          SELECT 1 FROM donation_intents WHERE provider_creation_claim_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM stripe_checkout_sessions WHERE provider_creation_claim_id = ?
        )`
  ).bind(id, id, id).run();
}

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

export async function releaseUnusedDonationIntentRateLimitClaim(
  db: D1Database,
  id: string
): Promise<void> {
  await db.prepare(
    `DELETE FROM security_rate_limit_claims
      WHERE id = ? AND scope = 'donation_intent'
        AND NOT EXISTS (
          SELECT 1 FROM donation_intents WHERE rate_limit_claim_id = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM stripe_checkout_sessions WHERE rate_limit_claim_id = ?
        )`
  ).bind(id, id, id).run();
}

export async function claimStripeProviderRecoveryRead(
  db: D1Database,
  input: {
    kind: "OPEN_REPLAY" | "STATUS_RECOVERY";
    identityHash: string;
    ipHash: string;
    now: string;
    cutoff: string;
    leaseExpiresAt: string;
    expiresAt: string;
    identityLimit: number;
    ipLimit: number;
  }
): Promise<StripeProviderRecoveryClaim> {
  await db.prepare(
    `UPDATE stripe_provider_recovery_reads
        SET status = 'FAILED', completed_at = ?, updated_at = ?
      WHERE status = 'PROCESSING' AND lease_expires_at <= ?`
  ).bind(input.now, input.now, input.now).run();
  const id = newId("stripe_recovery_read");
  const row = await db.prepare(
    `INSERT INTO stripe_provider_recovery_reads (
       id, kind, identity_hash, ip_hash, status, provider_started_at,
       lease_expires_at, completed_at, created_at, updated_at, expires_at
     )
     SELECT ?, ?, ?, ?, 'PROCESSING', ?, ?, NULL, ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM stripe_provider_recovery_reads
         WHERE kind = ? AND identity_hash = ? AND status = 'PROCESSING'
      )
        AND (SELECT COUNT(*) FROM stripe_provider_recovery_reads
              WHERE identity_hash = ? AND created_at >= ?) < ?
        AND (SELECT COUNT(*) FROM stripe_provider_recovery_reads
              WHERE ip_hash = ? AND created_at >= ?) < ?
     RETURNING id`
  ).bind(
    id,
    input.kind,
    input.identityHash,
    input.ipHash,
    input.now,
    input.leaseExpiresAt,
    input.now,
    input.now,
    input.expiresAt,
    input.kind,
    input.identityHash,
    input.identityHash,
    input.cutoff,
    input.identityLimit,
    input.ipHash,
    input.cutoff,
    input.ipLimit
  ).first<{ id: string }>();
  if (row) return { kind: "CLAIMED", id: row.id };
  const active = await db.prepare(
    `SELECT id FROM stripe_provider_recovery_reads
      WHERE kind = ? AND identity_hash = ? AND status = 'PROCESSING'
      LIMIT 1`
  ).bind(input.kind, input.identityHash).first<{ id: string }>();
  return active ? { kind: "IN_PROGRESS" } : { kind: "LIMITED" };
}

export async function finalizeStripeProviderRecoveryRead(
  db: D1Database,
  input: { id: string; outcome: "COMPLETE" | "FAILED"; now: string }
): Promise<void> {
  await db.prepare(
    `UPDATE stripe_provider_recovery_reads
        SET status = ?, completed_at = ?, updated_at = ?
      WHERE id = ? AND status = 'PROCESSING'`
  ).bind(input.outcome, input.now, input.now, input.id).run();
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

export async function claimStripePortalRateLimit(
  db: D1Database,
  input: {
    ipKeyHash: string;
    customerKeyHash: string;
    now: string;
    cutoff: string;
    expiresAt: string;
    ipLimit: number;
    customerLimit: number;
    aggregateLimit: number;
  }
): Promise<string | null> {
  const id = newId("stripe_portal_rate");
  const row = await db.prepare(
    `INSERT INTO stripe_portal_rate_limit_claims (
       id, ip_key_hash, customer_key_hash, claimed_at, expires_at
     )
     SELECT ?, ?, ?, ?, ?
      WHERE (
        SELECT COUNT(*) FROM stripe_portal_rate_limit_claims
         WHERE ip_key_hash = ? AND claimed_at >= ?
      ) < ?
        AND (
          SELECT COUNT(*) FROM stripe_portal_rate_limit_claims
           WHERE customer_key_hash = ? AND claimed_at >= ?
        ) < ?
        AND (
          SELECT COUNT(*) FROM stripe_portal_rate_limit_claims
           WHERE claimed_at >= ?
        ) < ?
     RETURNING id`
  ).bind(
    id,
    input.ipKeyHash,
    input.customerKeyHash,
    input.now,
    input.expiresAt,
    input.ipKeyHash,
    input.cutoff,
    input.ipLimit,
    input.customerKeyHash,
    input.cutoff,
    input.customerLimit,
    input.cutoff,
    input.aggregateLimit
  ).first<{ id: string }>();
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

export async function countRecentAccountLoginFailures(
  db: D1Database,
  normalizedEmail: string,
  sinceIso: string
): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS count
         FROM audit_logs
        WHERE action = 'LOGIN_FAILED'
          AND entity_type = 'user'
          AND entity_id = ?
          AND created_at >= ?`
    )
    .bind(normalizedEmail, sinceIso)
    .first<{ count: number }>();
  return Number(row?.count ?? 0);
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
  await db.prepare(
    "DELETE FROM stripe_provider_recovery_reads WHERE expires_at <= ? AND status <> 'PROCESSING'"
  ).bind(now).run();
  await db.prepare(
    "DELETE FROM stripe_portal_rate_limit_claims WHERE expires_at <= ?"
  ).bind(now).run();
  await db.prepare(
    "DELETE FROM provider_creation_claims WHERE expires_at <= ?"
  ).bind(now).run();
}
