import { eq, and, count } from 'drizzle-orm';
import { getDb } from '../connection';
import {
  applicationPermissions,
  type ApplicationPermission,
  type NewApplicationPermission,
} from '../schema';

export const applicationPermissionRepository = {
  async findByApplicationId(
    applicationId: string,
  ): Promise<ApplicationPermission[]> {
    const db = getDb();
    return db
      .select()
      .from(applicationPermissions)
      .where(eq(applicationPermissions.applicationId, applicationId));
  },

  async findByApplicationAndResource(
    applicationId: string,
    resource: string,
  ): Promise<ApplicationPermission[]> {
    const db = getDb();
    return db
      .select()
      .from(applicationPermissions)
      .where(
        eq(applicationPermissions.applicationId, applicationId) &&
          eq(applicationPermissions.resource, resource),
      );
  },

  async findByApplicationResourceAction(
    applicationId: string,
    resource: string,
    action: string,
  ): Promise<ApplicationPermission | undefined> {
    const db = getDb();
    const rows = await db
      .select()
      .from(applicationPermissions)
      .where(
        eq(applicationPermissions.applicationId, applicationId) &&
          eq(applicationPermissions.resource, resource) &&
          eq(applicationPermissions.action, action),
      )
      .limit(1);
    return rows[0];
  },

  async create(
    data: NewApplicationPermission,
  ): Promise<ApplicationPermission> {
    const db = getDb();
    const rows = await db
      .insert(applicationPermissions)
      .values(data)
      .returning();
    return rows[0];
  },

  async createMany(
    records: NewApplicationPermission[],
  ): Promise<ApplicationPermission[]> {
    const db = getDb();
    const rows = await db
      .insert(applicationPermissions)
      .values(records)
      .returning();
    return rows;
  },

  async deleteByApplicationId(applicationId: string): Promise<number> {
    const db = getDb();
    const rows = await db
      .delete(applicationPermissions)
      .where(eq(applicationPermissions.applicationId, applicationId))
      .returning();
    return rows.length;
  },

  async deleteByApplicationResource(
    applicationId: string,
    resource: string,
  ): Promise<number> {
    const db = getDb();
    const rows = await db
      .delete(applicationPermissions)
      .where(
        eq(applicationPermissions.applicationId, applicationId) &&
          eq(applicationPermissions.resource, resource),
      )
      .returning();
    return rows.length;
  },

  async count(): Promise<number> {
    const db = getDb();
    const rows = await db
      .select({ value: count() })
      .from(applicationPermissions);
    return rows[0]?.value ?? 0;
  },
};
