import {
  pgTable,
  uuid,
  text,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { users } from './users';

// Single-use tokens for both email verification and password reset —
// same shape, different `purpose`, so this doesn't need two near-identical
// tables. A token is consumed by setting usedAt; a used or expired token
// is never accepted again.
export const userVerificationTokens = pgTable(
  'user_verification_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(), // 'email_verification' | 'password_reset'
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('idx_user_verification_tokens_user_id').on(t.userId),
    uniqueIndex('idx_user_verification_tokens_hash').on(t.tokenHash),
    index('idx_user_verification_tokens_purpose').on(t.purpose),
  ],
);

export type UserVerificationToken = typeof userVerificationTokens.$inferSelect;
export type NewUserVerificationToken = typeof userVerificationTokens.$inferInsert;
