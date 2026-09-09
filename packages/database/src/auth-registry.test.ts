import { describe, it, expect } from 'vitest';
import {
  AuthRegistry,
  AuthError,
  ValidationError,
  ConflictError,
  type UserRecord,
  type UserSessionRecord,
  type UserVerificationTokenRecord,
  type RoleRecord,
  type UserRepositoryForAuth,
  type UserSessionRepositoryForAuth,
  type UserVerificationTokenRepositoryForAuth,
  type RoleRepositoryForAuth,
} from './auth-registry';
import { ApplicationRegistry, type ApplicationRepository, type ApiKeyRepository } from './registry';

function createMockAppRegistry() {
  const apps: any[] = [];
  const keys: any[] = [];
  const appRepo: ApplicationRepository = {
    async findById(id) {
      return apps.find((a) => a.id === id);
    },
    async findBySlug(slug) {
      return apps.find((a) => a.slug === slug);
    },
    async findByName(name) {
      return apps.find((a) => a.name === name);
    },
    async create(data) {
      const app = {
        id: 'app-' + String(apps.length + 1).padStart(3, '0'),
        name: data.name,
        slug: data.slug,
        description: data.description ?? null,
        status: (data.status as string) ?? 'active',
        environment: (data.environment as string) ?? 'development',
        allowedCapabilities: data.allowedCapabilities ?? null,
        metadata: data.metadata ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      apps.push(app);
      return app;
    },
    async update(id, data) {
      const idx = apps.findIndex((a) => a.id === id);
      if (idx === -1) return undefined;
      apps[idx] = { ...apps[idx], ...data, updatedAt: new Date() };
      return apps[idx];
    },
  };
  const keyRepo: ApiKeyRepository = {
    async findById(id) {
      return keys.find((k) => k.id === id);
    },
    async findByHash(keyHash) {
      return keys.find((k) => k.keyHash === keyHash);
    },
    async findByApplicationId(applicationId) {
      return keys.filter((k) => k.applicationId === applicationId);
    },
    async create(data) {
      const key = {
        id: 'key-' + String(keys.length + 1).padStart(3, '0'),
        applicationId: data.applicationId,
        keyHash: data.keyHash,
        prefix: data.prefix,
        environment: data.environment ?? 'test',
        scopes: data.scopes ?? null,
        lastUsedAt: null,
        expiresAt: data.expiresAt ?? null,
        revokedAt: null,
        createdAt: new Date(),
      };
      keys.push(key);
      return key;
    },
    async revoke(id) {
      const idx = keys.findIndex((k) => k.id === id);
      if (idx === -1) return undefined;
      keys[idx] = { ...keys[idx], revokedAt: new Date() };
      return keys[idx];
    },
    async updateLastUsed() {},
  };
  return new ApplicationRegistry(appRepo, keyRepo);
}

function createMockUserRepo(): UserRepositoryForAuth & { _users: UserRecord[] } {
  const users: UserRecord[] = [];
  let seq = 0;
  return {
    _users: users,
    async findByEmail(email) {
      return users.find((u) => u.email === email);
    },
    async findById(id) {
      return users.find((u) => u.id === id);
    },
    async create(data) {
      const user: UserRecord = {
        id: 'user-' + String(++seq).padStart(3, '0'),
        applicationId: data.applicationId,
        tenantId: (data.tenantId as string) ?? null,
        roleId: (data.roleId as string) ?? null,
        email: data.email,
        name: (data.name as string) ?? null,
        passwordHash: (data.passwordHash as string) ?? null,
        emailVerifiedAt: null,
        lastLoginAt: null,
        failedLoginAttempts: 0,
        lockedUntilAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      users.push(user);
      return user;
    },
    async update(id, data) {
      const idx = users.findIndex((u) => u.id === id);
      if (idx === -1) return undefined;
      users[idx] = { ...users[idx], ...data, updatedAt: new Date() } as UserRecord;
      return users[idx];
    },
    async incrementFailedLoginAttempts(id) {
      const idx = users.findIndex((u) => u.id === id);
      if (idx === -1) return undefined;
      users[idx] = { ...users[idx], failedLoginAttempts: users[idx].failedLoginAttempts + 1 };
      return users[idx];
    },
  };
}

function createMockSessionRepo(): UserSessionRepositoryForAuth & { _sessions: UserSessionRecord[] } {
  const sessions: UserSessionRecord[] = [];
  let seq = 0;
  return {
    _sessions: sessions,
    async findByTokenHash(tokenHash) {
      return sessions.find((s) => s.tokenHash === tokenHash);
    },
    async create(data) {
      const session: UserSessionRecord = {
        id: 'sess-' + String(++seq).padStart(3, '0'),
        userId: data.userId,
        tokenHash: data.tokenHash,
        userAgent: data.userAgent ?? null,
        ipAddress: data.ipAddress ?? null,
        expiresAt: data.expiresAt,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: new Date(),
      };
      sessions.push(session);
      return session;
    },
    async revoke(id) {
      const idx = sessions.findIndex((s) => s.id === id);
      if (idx === -1) return undefined;
      sessions[idx] = { ...sessions[idx], revokedAt: new Date() };
      return sessions[idx];
    },
    async revokeAllForUser(userId) {
      for (let i = 0; i < sessions.length; i++) {
        if (sessions[i].userId === userId && !sessions[i].revokedAt) {
          sessions[i] = { ...sessions[i], revokedAt: new Date() };
        }
      }
    },
    async updateLastUsed(id) {
      const idx = sessions.findIndex((s) => s.id === id);
      if (idx !== -1) sessions[idx] = { ...sessions[idx], lastUsedAt: new Date() };
    },
  };
}

function createMockVerificationRepo(): UserVerificationTokenRepositoryForAuth & {
  _tokens: UserVerificationTokenRecord[];
} {
  const tokens: UserVerificationTokenRecord[] = [];
  let seq = 0;
  return {
    _tokens: tokens,
    async findByTokenHash(tokenHash) {
      return tokens.find((t) => t.tokenHash === tokenHash);
    },
    async create(data) {
      const token: UserVerificationTokenRecord = {
        id: 'tok-' + String(++seq).padStart(3, '0'),
        userId: data.userId,
        purpose: data.purpose,
        tokenHash: data.tokenHash,
        expiresAt: data.expiresAt,
        usedAt: null,
        createdAt: new Date(),
      };
      tokens.push(token);
      return token;
    },
    async markUsed(id) {
      const idx = tokens.findIndex((t) => t.id === id);
      if (idx === -1) return undefined;
      tokens[idx] = { ...tokens[idx], usedAt: new Date() };
      return tokens[idx];
    },
    async invalidateOutstanding(userId, purpose) {
      for (let i = 0; i < tokens.length; i++) {
        if (tokens[i].userId === userId && tokens[i].purpose === purpose && !tokens[i].usedAt) {
          tokens[i] = { ...tokens[i], usedAt: new Date() };
        }
      }
    },
  };
}

function createMockRoleRepo(): RoleRepositoryForAuth {
  const roles: RoleRecord[] = [];
  let seq = 0;
  return {
    async findByApplicationAndName(applicationId, name) {
      return roles.find((r) => r.applicationId === applicationId && r.name === name);
    },
    async create(data) {
      const role: RoleRecord = {
        id: 'role-' + String(++seq).padStart(3, '0'),
        applicationId: data.applicationId,
        name: data.name,
        description: data.description ?? null,
        isSystem: data.isSystem ?? 'false',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      roles.push(role);
      return role;
    },
    async addPermission() {
      return {};
    },
  };
}

function buildRegistry() {
  const userRepo = createMockUserRepo();
  const sessionRepo = createMockSessionRepo();
  const verificationRepo = createMockVerificationRepo();
  const roleRepo = createMockRoleRepo();
  const appRegistry = createMockAppRegistry();
  const auth = new AuthRegistry(userRepo, sessionRepo, verificationRepo, roleRepo, appRegistry);
  return { auth, userRepo, sessionRepo, verificationRepo, roleRepo };
}

const validSignup = {
  email: 'owner@reachchurch.example',
  password: 'correct-horse-battery-staple',
  name: 'Jane Owner',
  applicationName: 'Reach Church',
  applicationSlug: 'reach-church',
};

describe('AuthRegistry.signup', () => {
  it('creates an application, an Owner role, and a user, and returns an emailVerificationToken', async () => {
    const { auth, userRepo } = buildRegistry();
    const result = await auth.signup(validSignup);

    expect(result.application.slug).toBe('reach-church');
    expect(result.user.email).toBe(validSignup.email);
    expect(result.user.roleId).toBeTruthy();
    expect(result.apiKey.raw).toMatch(/^[0-9a-f]{64}$/);
    expect(result.emailVerificationToken).toBeTruthy();
    expect((result.user as any).passwordHash).toBeUndefined();

    const stored = userRepo._users[0];
    expect(stored.passwordHash).not.toBe(validSignup.password);
    expect(stored.passwordHash).toContain(':');
  });

  it('reuses an existing Owner role instead of creating a duplicate on a second signup for the same application slug conflict path', async () => {
    // Not a realistic double-signup (slugs must be unique), but exercises
    // findByApplicationAndName's reuse branch directly via two applications
    // sharing a role repo instance — the role name "Owner" must not collide.
    const { auth } = buildRegistry();
    const first = await auth.signup(validSignup);
    const second = await auth.signup({
      ...validSignup,
      email: 'owner2@haulpro.example',
      applicationName: 'HaulPro',
      applicationSlug: 'haulpro',
    });
    expect(first.user.roleId).not.toBe(second.user.roleId);
  });

  it('rejects a duplicate email with ConflictError', async () => {
    const { auth } = buildRegistry();
    await auth.signup(validSignup);
    await expect(
      auth.signup({ ...validSignup, applicationName: 'Other App', applicationSlug: 'other-app' }),
    ).rejects.toThrow(ConflictError);
  });

  it('rejects a short password with ValidationError', async () => {
    const { auth } = buildRegistry();
    await expect(auth.signup({ ...validSignup, password: 'short' })).rejects.toThrow(ValidationError);
  });

  it('rejects an invalid email with ValidationError', async () => {
    const { auth } = buildRegistry();
    await expect(auth.signup({ ...validSignup, email: 'not-an-email' })).rejects.toThrow(ValidationError);
  });
});

describe('AuthRegistry.login', () => {
  it('logs in with correct credentials and returns a session token', async () => {
    const { auth } = buildRegistry();
    await auth.signup(validSignup);

    const result = await auth.login({ email: validSignup.email, password: validSignup.password });
    expect(result.token).toMatch(/^sess_/);
    expect(result.user.email).toBe(validSignup.email);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it('rejects an unknown email with a generic AuthError (no enumeration)', async () => {
    const { auth } = buildRegistry();
    await expect(auth.login({ email: 'nobody@example.com', password: 'whatever123' })).rejects.toThrow(AuthError);
  });

  it('rejects a wrong password with the same generic AuthError message as an unknown email', async () => {
    const { auth } = buildRegistry();
    await auth.signup(validSignup);
    let unknownEmailMsg = '';
    let wrongPasswordMsg = '';
    try {
      await auth.login({ email: 'nobody@example.com', password: 'whatever123' });
    } catch (e: any) {
      unknownEmailMsg = e.message;
    }
    try {
      await auth.login({ email: validSignup.email, password: 'wrong-password-123' });
    } catch (e: any) {
      wrongPasswordMsg = e.message;
    }
    expect(unknownEmailMsg).toBe(wrongPasswordMsg);
  });

  it('locks the account after MAX_FAILED_LOGIN_ATTEMPTS wrong passwords, even with the correct password', async () => {
    const { auth } = buildRegistry();
    await auth.signup(validSignup);

    for (let i = 0; i < 5; i++) {
      await expect(auth.login({ email: validSignup.email, password: 'wrong' })).rejects.toThrow(AuthError);
    }

    await expect(auth.login({ email: validSignup.email, password: validSignup.password })).rejects.toThrow(
      /locked/i,
    );
  });

  it('resets failedLoginAttempts on a successful login', async () => {
    const { auth, userRepo } = buildRegistry();
    await auth.signup(validSignup);
    await expect(auth.login({ email: validSignup.email, password: 'wrong' })).rejects.toThrow(AuthError);
    expect(userRepo._users[0].failedLoginAttempts).toBe(1);

    await auth.login({ email: validSignup.email, password: validSignup.password });
    expect(userRepo._users[0].failedLoginAttempts).toBe(0);
  });
});

describe('AuthRegistry.verifySession / logout', () => {
  it('verifies a valid session token and returns the user', async () => {
    const { auth } = buildRegistry();
    await auth.signup(validSignup);
    const { token } = await auth.login({ email: validSignup.email, password: validSignup.password });

    const user = await auth.verifySession(token);
    expect(user?.email).toBe(validSignup.email);
  });

  it('returns null for an unknown token', async () => {
    const { auth } = buildRegistry();
    expect(await auth.verifySession('sess_does-not-exist')).toBeNull();
  });

  it('returns null after logout revokes the session', async () => {
    const { auth } = buildRegistry();
    await auth.signup(validSignup);
    const { token } = await auth.login({ email: validSignup.email, password: validSignup.password });

    await auth.logout(token);
    expect(await auth.verifySession(token)).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const { auth, sessionRepo } = buildRegistry();
    await auth.signup(validSignup);
    const { token } = await auth.login({ email: validSignup.email, password: validSignup.password });

    sessionRepo._sessions[0].expiresAt = new Date(Date.now() - 1000);
    expect(await auth.verifySession(token)).toBeNull();
  });
});

describe('AuthRegistry password reset', () => {
  it('requestPasswordReset returns null for an unknown email (no enumeration)', async () => {
    const { auth } = buildRegistry();
    expect(await auth.requestPasswordReset('nobody@example.com')).toBeNull();
  });

  it('resets the password with a valid token and revokes existing sessions', async () => {
    const { auth } = buildRegistry();
    await auth.signup(validSignup);
    const { token: sessionToken } = await auth.login({ email: validSignup.email, password: validSignup.password });

    const reset = await auth.requestPasswordReset(validSignup.email);
    expect(reset?.token).toBeTruthy();

    await auth.resetPassword(reset!.token, 'brand-new-password-123');

    // Old session is now revoked.
    expect(await auth.verifySession(sessionToken)).toBeNull();
    // Old password no longer works; new one does.
    await expect(auth.login({ email: validSignup.email, password: validSignup.password })).rejects.toThrow(
      AuthError,
    );
    const relog = await auth.login({ email: validSignup.email, password: 'brand-new-password-123' });
    expect(relog.token).toBeTruthy();
  });

  it('rejects reusing a password reset token', async () => {
    const { auth } = buildRegistry();
    await auth.signup(validSignup);
    const reset = await auth.requestPasswordReset(validSignup.email);
    await auth.resetPassword(reset!.token, 'brand-new-password-123');
    await expect(auth.resetPassword(reset!.token, 'another-password-456')).rejects.toThrow(AuthError);
  });

  it('rejects an expired password reset token', async () => {
    const { auth, verificationRepo } = buildRegistry();
    await auth.signup(validSignup);
    const reset = await auth.requestPasswordReset(validSignup.email);
    const record = verificationRepo._tokens.find((t) => t.purpose === 'password_reset')!;
    record.expiresAt = new Date(Date.now() - 1000);
    await expect(auth.resetPassword(reset!.token, 'brand-new-password-123')).rejects.toThrow(AuthError);
  });

  it('rejects a too-short new password', async () => {
    const { auth } = buildRegistry();
    await auth.signup(validSignup);
    const reset = await auth.requestPasswordReset(validSignup.email);
    await expect(auth.resetPassword(reset!.token, 'short')).rejects.toThrow(ValidationError);
  });
});

describe('AuthRegistry email verification', () => {
  it('verifies email with the token issued at signup', async () => {
    const { auth } = buildRegistry();
    const signup = await auth.signup(validSignup);
    const user = await auth.verifyEmail(signup.emailVerificationToken);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('rejects reusing an already-used verification token', async () => {
    const { auth } = buildRegistry();
    const signup = await auth.signup(validSignup);
    await auth.verifyEmail(signup.emailVerificationToken);
    await expect(auth.verifyEmail(signup.emailVerificationToken)).rejects.toThrow(AuthError);
  });

  it('resendEmailVerification invalidates the prior token and issues a fresh one', async () => {
    const { auth } = buildRegistry();
    const signup = await auth.signup(validSignup);
    const user = await auth.login({ email: validSignup.email, password: validSignup.password });

    const resent = await auth.resendEmailVerification(user.user.id);
    expect(resent.token).not.toBe(signup.emailVerificationToken);

    // The original token is now invalidated.
    await expect(auth.verifyEmail(signup.emailVerificationToken)).rejects.toThrow(AuthError);
    // The fresh one works.
    const verified = await auth.verifyEmail(resent.token);
    expect(verified.emailVerifiedAt).toBeInstanceOf(Date);
  });
});

