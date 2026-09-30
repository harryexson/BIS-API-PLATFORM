import type { NewUser } from './schema';
import {
  hashPassword,
  verifyPassword,
  hashToken,
  generateSessionToken,
  generateVerificationToken,
} from './crypto';
import type { ApplicationRegistry, ApplicationRecord } from './registry';

// Configurable via env, matching the pattern used by the circuit breaker
// (CIRCUIT_BREAKER_*) elsewhere in this platform.
const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS ?? 24 * 30) * 60 * 60 * 1000;
const EMAIL_VERIFICATION_TTL_MS = Number(process.env.EMAIL_VERIFICATION_TTL_HOURS ?? 24) * 60 * 60 * 1000;
const PASSWORD_RESET_TTL_MS = Number(process.env.PASSWORD_RESET_TTL_HOURS ?? 1) * 60 * 60 * 1000;
const MAX_FAILED_LOGIN_ATTEMPTS = Number(process.env.MAX_FAILED_LOGIN_ATTEMPTS ?? 5);
const LOCKOUT_DURATION_MS = Number(process.env.ACCOUNT_LOCKOUT_MINUTES ?? 15) * 60 * 1000;
const MIN_PASSWORD_LENGTH = 8;

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthError';
  }
}

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConflictError';
  }
}

export interface UserRecord {
  id: string;
  applicationId: string;
  tenantId: string | null;
  roleId: string | null;
  email: string;
  name: string | null;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  lastLoginAt: Date | null;
  failedLoginAttempts: number;
  lockedUntilAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type PublicUser = Omit<UserRecord, 'passwordHash'>;

export interface UserSessionRecord {
  id: string;
  userId: string;
  tokenHash: string;
  userAgent: string | null;
  ipAddress: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  createdAt: Date;
}

export interface UserVerificationTokenRecord {
  id: string;
  userId: string;
  purpose: string;
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface RoleRecord {
  id: string;
  applicationId: string;
  name: string;
  description: string | null;
  isSystem: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserRepositoryForAuth {
  findByEmail(email: string): Promise<UserRecord | undefined>;
  findById(id: string): Promise<UserRecord | undefined>;
  create(data: NewUser): Promise<UserRecord>;
  update(id: string, data: Partial<NewUser>): Promise<UserRecord | undefined>;
  incrementFailedLoginAttempts(id: string): Promise<UserRecord | undefined>;
}

export interface UserSessionRepositoryForAuth {
  findByTokenHash(tokenHash: string): Promise<UserSessionRecord | undefined>;
  create(data: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent?: string | null;
    ipAddress?: string | null;
  }): Promise<UserSessionRecord>;
  revoke(id: string): Promise<UserSessionRecord | undefined>;
  revokeAllForUser(userId: string): Promise<void>;
  updateLastUsed(id: string): Promise<void>;
}

export interface UserVerificationTokenRepositoryForAuth {
  findByTokenHash(tokenHash: string): Promise<UserVerificationTokenRecord | undefined>;
  create(data: {
    userId: string;
    purpose: string;
    tokenHash: string;
    expiresAt: Date;
  }): Promise<UserVerificationTokenRecord>;
  markUsed(id: string): Promise<UserVerificationTokenRecord | undefined>;
  invalidateOutstanding(userId: string, purpose: string): Promise<void>;
}

export interface RoleRepositoryForAuth {
  findByApplicationAndName(applicationId: string, name: string): Promise<RoleRecord | undefined>;
  create(data: {
    applicationId: string;
    name: string;
    description?: string | null;
    isSystem?: string;
  }): Promise<RoleRecord>;
  addPermission(data: { roleId: string; resource: string; action: string }): Promise<unknown>;
}

export interface SignupInput {
  email: string;
  password: string;
  name?: string;
  applicationName: string;
  applicationSlug: string;
}

export interface SignupResult {
  user: PublicUser;
  application: ApplicationRecord;
  apiKey: { raw: string; prefix: string; environment: string };
  emailVerificationToken: string;
}

export interface LoginInput {
  email: string;
  password: string;
  userAgent?: string;
  ipAddress?: string;
}

export interface LoginResult {
  user: PublicUser;
  token: string;
  expiresAt: Date;
}

// Customer-facing account auth — signup/login for the developers/businesses
// that hold a BIS Platform application (e.g. "Reach Church"), distinct from
// the existing per-application API-key auth used by /v1/api/gateway/* and
// the single shared-secret admin auth used by /api/dashboard/*. Sessions
// are opaque, revocable tokens (same design as application_api_keys),
// not stateless JWTs, so logout/password-reset can invalidate them
// immediately.
export class AuthRegistry {
  constructor(
    private readonly userRepo: UserRepositoryForAuth,
    private readonly sessionRepo: UserSessionRepositoryForAuth,
    private readonly verificationRepo: UserVerificationTokenRepositoryForAuth,
    private readonly roleRepo: RoleRepositoryForAuth,
    private readonly appRegistry: ApplicationRegistry,
  ) {}

  private toPublicUser(user: UserRecord): PublicUser {
    const { passwordHash: _passwordHash, ...rest } = user;
    return rest;
  }

  private validatePassword(password: string): void {
    if (!password || password.length < MIN_PASSWORD_LENGTH) {
      throw new ValidationError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
    }
  }

  // Signup provisions both the account (user) and the BIS Platform
  // application it owns in one step — this platform's self-serve model is
  // "one signup creates one application", matching users.applicationId
  // being a required (not nullable) foreign key.
  async signup(input: SignupInput): Promise<SignupResult> {
    if (!input.email || !input.email.includes('@')) {
      throw new ValidationError('A valid email is required');
    }
    this.validatePassword(input.password);
    if (!input.applicationName || !input.applicationSlug) {
      throw new ValidationError('applicationName and applicationSlug are required');
    }

    const existing = await this.userRepo.findByEmail(input.email);
    if (existing) {
      throw new ConflictError('An account with this email already exists');
    }

    const { application, apiKey } = await this.appRegistry.createApplication({
      name: input.applicationName,
      slug: input.applicationSlug,
      environment: 'development',
    });

    let role = await this.roleRepo.findByApplicationAndName(application.id, 'Owner');
    if (!role) {
      role = await this.roleRepo.create({
        applicationId: application.id,
        name: 'Owner',
        description: "Full access — created automatically for the application's first user",
        isSystem: 'true',
      });
      await this.roleRepo.addPermission({ roleId: role.id, resource: '*', action: '*' });
    }

    const passwordHash = hashPassword(input.password);
    const user = await this.userRepo.create({
      applicationId: application.id,
      roleId: role.id,
      email: input.email,
      name: input.name ?? null,
      passwordHash,
    });

    const verification = generateVerificationToken();
    await this.verificationRepo.create({
      userId: user.id,
      purpose: 'email_verification',
      tokenHash: verification.hash,
      expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    });

    return {
      user: this.toPublicUser(user),
      application,
      apiKey: { raw: apiKey.raw, prefix: apiKey.prefix, environment: apiKey.environment },
      emailVerificationToken: verification.raw,
    };
  }

  async login(input: LoginInput): Promise<LoginResult> {
    const user = await this.userRepo.findByEmail(input.email);
    // Same generic error whether the email doesn't exist or the password
    // is wrong — never reveal which one, to avoid account enumeration.
    if (!user || !user.passwordHash) {
      throw new AuthError('Invalid email or password');
    }

    if (user.lockedUntilAt && new Date(user.lockedUntilAt) > new Date()) {
      throw new AuthError(
        `Account temporarily locked after too many failed attempts. Try again after ${new Date(user.lockedUntilAt).toISOString()}`,
      );
    }

    const valid = verifyPassword(input.password, user.passwordHash);
    if (!valid) {
      const updated = await this.userRepo.incrementFailedLoginAttempts(user.id);
      if (updated && updated.failedLoginAttempts >= MAX_FAILED_LOGIN_ATTEMPTS) {
        await this.userRepo.update(user.id, {
          lockedUntilAt: new Date(Date.now() + LOCKOUT_DURATION_MS),
        });
      }
      throw new AuthError('Invalid email or password');
    }

    const refreshed = await this.userRepo.update(user.id, {
      failedLoginAttempts: 0,
      lockedUntilAt: null,
      lastLoginAt: new Date(),
    });

    const session = generateSessionToken();
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.sessionRepo.create({
      userId: user.id,
      tokenHash: session.hash,
      expiresAt,
      userAgent: input.userAgent ?? null,
      ipAddress: input.ipAddress ?? null,
    });

    return { user: this.toPublicUser(refreshed ?? user), token: session.raw, expiresAt };
  }

  async logout(rawToken: string): Promise<void> {
    const hash = hashToken(rawToken);
    const session = await this.sessionRepo.findByTokenHash(hash);
    if (session && !session.revokedAt) {
      await this.sessionRepo.revoke(session.id);
    }
  }

  async verifySession(rawToken: string): Promise<PublicUser | null> {
    const hash = hashToken(rawToken);
    const session = await this.sessionRepo.findByTokenHash(hash);
    if (!session || session.revokedAt) return null;
    if (new Date(session.expiresAt) < new Date()) return null;

    const user = await this.userRepo.findById(session.userId);
    if (!user) return null;

    await this.sessionRepo.updateLastUsed(session.id);
    return this.toPublicUser(user);
  }

  // Always returns a result shape regardless of whether the email exists —
  // callers must not let this leak account existence to the requester.
  async requestPasswordReset(email: string): Promise<{ token: string } | null> {
    const user = await this.userRepo.findByEmail(email);
    if (!user) return null;

    await this.verificationRepo.invalidateOutstanding(user.id, 'password_reset');
    const token = generateVerificationToken();
    await this.verificationRepo.create({
      userId: user.id,
      purpose: 'password_reset',
      tokenHash: token.hash,
      expiresAt: new Date(Date.now() + PASSWORD_RESET_TTL_MS),
    });
    return { token: token.raw };
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    this.validatePassword(newPassword);
    const hash = hashToken(rawToken);
    const record = await this.verificationRepo.findByTokenHash(hash);
    if (
      !record ||
      record.purpose !== 'password_reset' ||
      record.usedAt ||
      new Date(record.expiresAt) < new Date()
    ) {
      throw new AuthError('Invalid or expired reset token');
    }

    const passwordHash = hashPassword(newPassword);
    await this.userRepo.update(record.userId, {
      passwordHash,
      failedLoginAttempts: 0,
      lockedUntilAt: null,
    });
    await this.verificationRepo.markUsed(record.id);
    // A password reset invalidates any session created before the account
    // owner regained control.
    await this.sessionRepo.revokeAllForUser(record.userId);
  }

  async resendEmailVerification(userId: string): Promise<{ token: string }> {
    await this.verificationRepo.invalidateOutstanding(userId, 'email_verification');
    const token = generateVerificationToken();
    await this.verificationRepo.create({
      userId,
      purpose: 'email_verification',
      tokenHash: token.hash,
      expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS),
    });
    return { token: token.raw };
  }

  async verifyEmail(rawToken: string): Promise<PublicUser> {
    const hash = hashToken(rawToken);
    const record = await this.verificationRepo.findByTokenHash(hash);
    if (
      !record ||
      record.purpose !== 'email_verification' ||
      record.usedAt ||
      new Date(record.expiresAt) < new Date()
    ) {
      throw new AuthError('Invalid or expired verification token');
    }

    const user = await this.userRepo.update(record.userId, { emailVerifiedAt: new Date() });
    await this.verificationRepo.markUsed(record.id);
    if (!user) throw new AuthError('User not found');
    return this.toPublicUser(user);
  }
}
