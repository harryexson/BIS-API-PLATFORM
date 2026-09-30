import type { NewCustomerNote, NewSupportTicket, NewTicketComment } from './schema';

/**
 * Read/write surface for the developer-CRM / support back office — BIS
 * staff-facing (admin-token-gated in the gateway), not customer-facing.
 * "Customer" here means an `application` (the businesses that hold BIS
 * Platform access — Reach Church, HaulPro, etc.), matching the same
 * definition used throughout the 2026-09-09 auth/subscriptions work.
 */

export interface ApplicationSummary {
  id: string;
  name: string;
  slug: string;
  status: string;
  environment: string;
  createdAt: Date;
}

export interface SubscriptionSummary {
  id: string;
  status: string;
  planId: string;
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
}

export interface PlanSummary {
  id: string;
  slug: string;
  name: string;
}

export interface UserSummary {
  id: string;
  email: string;
  name: string | null;
  lastLoginAt: Date | null;
  emailVerifiedAt: Date | null;
}

export interface CustomerNoteRecord {
  id: string;
  applicationId: string;
  authorName: string;
  body: string;
  createdAt: Date;
}

export interface SupportTicketRecord {
  id: string;
  applicationId: string;
  subject: string;
  description: string;
  status: string;
  priority: string;
  requesterEmail: string | null;
  createdAt: Date;
  updatedAt: Date;
  resolvedAt: Date | null;
}

export interface TicketCommentRecord {
  id: string;
  ticketId: string;
  authorName: string;
  body: string;
  createdAt: Date;
}

export interface CustomerSummary {
  application: ApplicationSummary;
  subscription: SubscriptionSummary | null;
  plan: PlanSummary | null;
  userCount: number;
  openTicketCount: number;
}

export interface CustomerDetail extends CustomerSummary {
  users: UserSummary[];
  notes: CustomerNoteRecord[];
  tickets: SupportTicketRecord[];
}

export interface ApplicationRepositoryForCrm {
  findAll(): Promise<ApplicationSummary[]>;
  findById(id: string): Promise<ApplicationSummary | undefined>;
}

export interface SubscriptionRepositoryForCrm {
  findByApplicationId(applicationId: string): Promise<SubscriptionSummary | undefined>;
}

export interface PlanRepositoryForCrm {
  findById(id: string): Promise<PlanSummary | undefined>;
}

export interface UserRepositoryForCrm {
  findByApplicationId(applicationId: string): Promise<UserSummary[]>;
}

export interface CustomerNoteRepositoryForCrm {
  findByApplicationId(applicationId: string): Promise<CustomerNoteRecord[]>;
  create(data: NewCustomerNote): Promise<CustomerNoteRecord>;
}

export interface SupportTicketRepositoryForCrm {
  findById(id: string): Promise<SupportTicketRecord | undefined>;
  findByApplicationId(applicationId: string): Promise<SupportTicketRecord[]>;
  findAll(status?: string): Promise<SupportTicketRecord[]>;
  countOpenByApplicationId(applicationId: string): Promise<number>;
  create(data: NewSupportTicket): Promise<SupportTicketRecord>;
  update(id: string, data: Partial<NewSupportTicket>): Promise<SupportTicketRecord | undefined>;
}

export interface TicketCommentRepositoryForCrm {
  findByTicketId(ticketId: string): Promise<TicketCommentRecord[]>;
  create(data: NewTicketComment): Promise<TicketCommentRecord>;
}

const TICKET_STATUSES = ['open', 'in_progress', 'resolved', 'closed'];
const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

export class CrmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CrmError';
  }
}

export class CrmRegistry {
  constructor(
    private readonly applicationRepo: ApplicationRepositoryForCrm,
    private readonly subscriptionRepo: SubscriptionRepositoryForCrm,
    private readonly planRepo: PlanRepositoryForCrm,
    private readonly userRepo: UserRepositoryForCrm,
    private readonly noteRepo: CustomerNoteRepositoryForCrm,
    private readonly ticketRepo: SupportTicketRepositoryForCrm,
    private readonly commentRepo: TicketCommentRepositoryForCrm,
  ) {}

  // Explicitly whitelists fields rather than trusting the repo's return
  // type — the real `userRepository.findByApplicationId` returns full
  // `User` rows (passwordHash included). TypeScript's structural typing
  // doesn't strip that field at runtime; only building a fresh object
  // here does. Never spread a user row directly into an API response.
  private toUserSummary(user: UserSummary): UserSummary {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      lastLoginAt: user.lastLoginAt,
      emailVerifiedAt: user.emailVerifiedAt,
    };
  }

  private async summarize(application: ApplicationSummary): Promise<CustomerSummary> {
    const [subscription, users, openTicketCount] = await Promise.all([
      this.subscriptionRepo.findByApplicationId(application.id),
      this.userRepo.findByApplicationId(application.id),
      this.ticketRepo.countOpenByApplicationId(application.id),
    ]);
    const plan = subscription ? await this.planRepo.findById(subscription.planId) : undefined;
    return {
      application,
      subscription: subscription ?? null,
      plan: plan ?? null,
      userCount: users.length,
      openTicketCount,
    };
  }

  async listCustomers(): Promise<CustomerSummary[]> {
    const applications = await this.applicationRepo.findAll();
    return Promise.all(applications.map((app) => this.summarize(app)));
  }

  async getCustomer(applicationId: string): Promise<CustomerDetail | null> {
    const application = await this.applicationRepo.findById(applicationId);
    if (!application) return null;

    const summary = await this.summarize(application);
    const [users, notes, tickets] = await Promise.all([
      this.userRepo.findByApplicationId(applicationId),
      this.noteRepo.findByApplicationId(applicationId),
      this.ticketRepo.findByApplicationId(applicationId),
    ]);

    return { ...summary, users: users.map((u) => this.toUserSummary(u)), notes, tickets };
  }

  async addNote(applicationId: string, authorName: string, body: string): Promise<CustomerNoteRecord> {
    if (!body || !body.trim()) throw new CrmError('Note body is required');
    const application = await this.applicationRepo.findById(applicationId);
    if (!application) throw new CrmError(`Application ${applicationId} not found`);
    return this.noteRepo.create({ applicationId, authorName: authorName || 'Admin', body });
  }

  async listTickets(status?: string): Promise<SupportTicketRecord[]> {
    if (status && !TICKET_STATUSES.includes(status)) {
      throw new CrmError(`Invalid status "${status}"`);
    }
    return this.ticketRepo.findAll(status);
  }

  async getTicket(ticketId: string): Promise<{ ticket: SupportTicketRecord; comments: TicketCommentRecord[] } | null> {
    const ticket = await this.ticketRepo.findById(ticketId);
    if (!ticket) return null;
    const comments = await this.commentRepo.findByTicketId(ticketId);
    return { ticket, comments };
  }

  async createTicket(
    applicationId: string,
    input: { subject: string; description: string; priority?: string; requesterEmail?: string },
  ): Promise<SupportTicketRecord> {
    if (!input.subject || !input.subject.trim()) throw new CrmError('subject is required');
    if (!input.description || !input.description.trim()) throw new CrmError('description is required');
    const priority = input.priority ?? 'normal';
    if (!TICKET_PRIORITIES.includes(priority)) throw new CrmError(`Invalid priority "${priority}"`);

    const application = await this.applicationRepo.findById(applicationId);
    if (!application) throw new CrmError(`Application ${applicationId} not found`);

    return this.ticketRepo.create({
      applicationId,
      subject: input.subject,
      description: input.description,
      priority,
      requesterEmail: input.requesterEmail ?? null,
    });
  }

  async updateTicket(
    ticketId: string,
    updates: { status?: string; priority?: string },
  ): Promise<SupportTicketRecord> {
    if (updates.status && !TICKET_STATUSES.includes(updates.status)) {
      throw new CrmError(`Invalid status "${updates.status}"`);
    }
    if (updates.priority && !TICKET_PRIORITIES.includes(updates.priority)) {
      throw new CrmError(`Invalid priority "${updates.priority}"`);
    }

    const existing = await this.ticketRepo.findById(ticketId);
    if (!existing) throw new CrmError(`Ticket ${ticketId} not found`);

    const isResolving = updates.status === 'resolved' || updates.status === 'closed';
    const updated = await this.ticketRepo.update(ticketId, {
      ...updates,
      resolvedAt: isResolving ? new Date() : existing.resolvedAt,
    });
    return updated!;
  }

  async addTicketComment(ticketId: string, authorName: string, body: string): Promise<TicketCommentRecord> {
    if (!body || !body.trim()) throw new CrmError('Comment body is required');
    const ticket = await this.ticketRepo.findById(ticketId);
    if (!ticket) throw new CrmError(`Ticket ${ticketId} not found`);
    return this.commentRepo.create({ ticketId, authorName: authorName || 'Admin', body });
  }
}
