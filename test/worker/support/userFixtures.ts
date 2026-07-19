import { InMemoryD1 } from "./inMemoryD1";

export function seededUserLifecycleDb(): InMemoryD1 {
  const db = new InMemoryD1();
  db.sessionUser = {
    id: "user_owner",
    email: "owner@example.org",
    name: "Owner",
    role: "OWNER"
  };
  db.users.push({
    id: "user_target",
    email: "target@example.org",
    name: "Target",
    role: "OPERATOR",
    password_hash: "target-hash",
    password_salt: "target-salt",
    disabled_at: null,
    updated_at: "2026-07-03T12:00:00.000Z"
  });
  for (let index = 0; index < 2; index += 1) {
    db.sessions.push({
      id: `session_lifecycle_${index}`,
      user_id: "user_target",
      token_hash: `lifecycle_token_${index}`,
      expires_at: "2026-07-05T12:00:00.000Z",
      created_at: `2026-07-04T11:0${index}:00.000Z`,
      revoked_at: null
    });
    db.resetTokens.push({
      id: `reset_lifecycle_${index}`,
      user_id: "user_target",
      token_hash: `reset_hash_${index}`,
      expires_at: "2026-07-05T12:00:00.000Z",
      used_at: null
    });
  }
  return db;
}
