import { describe, it, expect } from 'vitest';
import {
  CrmRegistry,
  CrmError,
  type ApplicationSummary,
  type SubscriptionSummary,
  type PlanSummary,
  type UserSummary,
  type CustomerNoteRecord,
  type SupportTicketRecord,
  type TicketCommentRecord,
  type ApplicationRepositoryForCrm,
  type SubscriptionRepositoryForCrm,
  type PlanRepositoryForCrm,
  type UserRepositoryForCrm,
  type CustomerNoteRepositoryForCrm,
  type SupportTicketRepositoryForCrm,
  type TicketCommentRepositoryForCrm,
} from './crm-registry';

function buildRegistry() {
  const applications: ApplicationSummary[] = [
    { id: 'app-1', name: 'Reach Church', slug: 'reach-church', status: 'active', environment: 'live', createdAt: new Date() },
    { id: 'app-2', name: 'HaulPro', slug: 'haulpro', status: 'active', environment: 'live', createdAt: new Date() },
  ];
  const subscriptions: SubscriptionSummary[] = [
    { id: 'sub-1', status: 'active', planId: 'plan-growth', currentPeriodEnd: new Date(), cancelAtPeriodEnd: false },
  ];
  const plans: PlanSummary[] = [{ id: 'plan-growth', slug: 'growth', name: 'Growth' }];
  // app-1 has a real user with a passwordHash the CRM must never leak.
  const usersByApp: Record<string, (UserSummary & { passwordHash?: string })[]> = {
    'app-1': [
      {
        id: 'user-1',
        email: 'owner@reachchurch.example',
        name: 'Jane',
        lastLoginAt: null,
        emailVerifiedAt: null,
        passwordHash: 'super-secret-scrypt-hash',
      },
    ],
    'app-2': [],
  };

  const notes: CustomerNoteRecord[] = [];
  const tickets: SupportTicketRecord[] = [];
  const comments: TicketCommentRecord[] = [];
  let noteSeq = 0;
  let ticketSeq = 0;
  let commentSeq = 0;

  const applicationRepo: ApplicationRepositoryForCrm = {
    async findAll() {
      return applications;
    },
    async findById(id) {
      return applications.find((a) => a.id === id);
    },
  };

  const subscriptionRepo: SubscriptionRepositoryForCrm = {
    async findByApplicationId(applicationId) {
      // Only app-1 has a subscription, deliberately, to exercise the
      // "no subscription yet" branch for app-2.
      return applicationId === 'app-1' ? subscriptions[0] : undefined;
    },
  };

  const planRepo: PlanRepositoryForCrm = {
    async findById(id) {
      return plans.find((p) => p.id === id);
    },
  };

  const userRepo: UserRepositoryForCrm = {
    async findByApplicationId(applicationId) {
      return usersByApp[applicationId] ?? [];
    },
  };

  const noteRepo: CustomerNoteRepositoryForCrm = {
    async findByApplicationId(applicationId) {
      return notes.filter((n) => n.applicationId === applicationId);
    },
    async create(data) {
      const row: CustomerNoteRecord = {
        id: 'note-' + String(++noteSeq).padStart(3, '0'),
        applicationId: data.applicationId,
        authorName: data.authorName,
        body: data.body,
        createdAt: new Date(),
      };
      notes.push(row);
      return row;
    },
  };

  const ticketRepo: SupportTicketRepositoryForCrm = {
    async findById(id) {
      return tickets.find((t) => t.id === id);
    },
    async findByApplicationId(applicationId) {
      return tickets.filter((t) => t.applicationId === applicationId);
    },
    async findAll(status) {
      return status ? tickets.filter((t) => t.status === status) : tickets;
    },
    async countOpenByApplicationId(applicationId) {
      return tickets.filter((t) => t.applicationId === applicationId && t.status === 'open').length;
    },
    async create(data) {
      const row: SupportTicketRecord = {
        id: 'ticket-' + String(++ticketSeq).padStart(3, '0'),
        applicationId: data.applicationId,
        subject: data.subject,
        description: data.description,
        status: (data.status as string) ?? 'open',
        priority: (data.priority as string) ?? 'normal',
        requesterEmail: (data.requesterEmail as string) ?? null,
        createdAt: new Date(),
        updatedAt: new Date(),
        resolvedAt: null,
      };
      tickets.push(row);
      return row;
    },
    async update(id, data) {
      const idx = tickets.findIndex((t) => t.id === id);
      if (idx === -1) return undefined;
      tickets[idx] = { ...tickets[idx], ...data, updatedAt: new Date() } as SupportTicketRecord;
      return tickets[idx];
    },
  };

  const commentRepo: TicketCommentRepositoryForCrm = {
    async findByTicketId(ticketId) {
      return comments.filter((c) => c.ticketId === ticketId);
    },
    async create(data) {
      const row: TicketCommentRecord = {
        id: 'comment-' + String(++commentSeq).padStart(3, '0'),
        ticketId: data.ticketId,
        authorName: data.authorName,
        body: data.body,
        createdAt: new Date(),
      };
      comments.push(row);
      return row;
    },
  };

  const registry = new CrmRegistry(applicationRepo, subscriptionRepo, planRepo, userRepo, noteRepo, ticketRepo, commentRepo);
  return { registry };
}

describe('CrmRegistry.listCustomers / getCustomer', () => {
  it('lists customers with subscription/plan/user/ticket summaries', async () => {
    const { registry } = buildRegistry();
    const customers = await registry.listCustomers();
    expect(customers).toHaveLength(2);

    const reachChurch = customers.find((c) => c.application.slug === 'reach-church')!;
    expect(reachChurch.subscription?.status).toBe('active');
    expect(reachChurch.plan?.slug).toBe('growth');
    expect(reachChurch.userCount).toBe(1);

    const haulpro = customers.find((c) => c.application.slug === 'haulpro')!;
    expect(haulpro.subscription).toBeNull();
    expect(haulpro.plan).toBeNull();
    expect(haulpro.userCount).toBe(0);
  });

  it('never leaks passwordHash through getCustomer', async () => {
    const { registry } = buildRegistry();
    const detail = await registry.getCustomer('app-1');
    expect(detail).not.toBeNull();
    expect(detail!.users).toHaveLength(1);
    expect('passwordHash' in detail!.users[0]).toBe(false);
  });

  it('returns null for an unknown application', async () => {
    const { registry } = buildRegistry();
    expect(await registry.getCustomer('nope')).toBeNull();
  });
});

describe('CrmRegistry notes', () => {
  it('adds a note and lists it back via getCustomer', async () => {
    const { registry } = buildRegistry();
    await registry.addNote('app-1', 'Support Rep', 'Called about billing question.');
    const detail = await registry.getCustomer('app-1');
    expect(detail!.notes).toHaveLength(1);
    expect(detail!.notes[0].body).toBe('Called about billing question.');
  });

  it('rejects an empty note body', async () => {
    const { registry } = buildRegistry();
    await expect(registry.addNote('app-1', 'Rep', '   ')).rejects.toThrow(CrmError);
  });

  it('rejects a note for an unknown application', async () => {
    const { registry } = buildRegistry();
    await expect(registry.addNote('nope', 'Rep', 'hi')).rejects.toThrow(CrmError);
  });
});

describe('CrmRegistry tickets', () => {
  it('creates a ticket, lists it, and reflects it in openTicketCount', async () => {
    const { registry } = buildRegistry();
    const ticket = await registry.createTicket('app-1', { subject: 'Cannot send SMS', description: 'Getting a 500 error.' });
    expect(ticket.status).toBe('open');
    expect(ticket.priority).toBe('normal');

    const customers = await registry.listCustomers();
    const reachChurch = customers.find((c) => c.application.slug === 'reach-church')!;
    expect(reachChurch.openTicketCount).toBe(1);
  });

  it('rejects an invalid priority', async () => {
    const { registry } = buildRegistry();
    await expect(
      registry.createTicket('app-1', { subject: 'x', description: 'y', priority: 'critical!!' }),
    ).rejects.toThrow(CrmError);
  });

  it('updates ticket status and sets resolvedAt when resolved', async () => {
    const { registry } = buildRegistry();
    const ticket = await registry.createTicket('app-1', { subject: 'x', description: 'y' });
    const updated = await registry.updateTicket(ticket.id, { status: 'resolved' });
    expect(updated.status).toBe('resolved');
    expect(updated.resolvedAt).toBeInstanceOf(Date);
  });

  it('rejects an invalid status transition value', async () => {
    const { registry } = buildRegistry();
    const ticket = await registry.createTicket('app-1', { subject: 'x', description: 'y' });
    await expect(registry.updateTicket(ticket.id, { status: 'not-a-status' })).rejects.toThrow(CrmError);
  });

  it('adds comments to a ticket via getTicket', async () => {
    const { registry } = buildRegistry();
    const ticket = await registry.createTicket('app-1', { subject: 'x', description: 'y' });
    await registry.addTicketComment(ticket.id, 'Support Rep', 'Looking into it.');

    const result = await registry.getTicket(ticket.id);
    expect(result?.comments).toHaveLength(1);
    expect(result?.comments[0].body).toBe('Looking into it.');
  });

  it('listTickets filters by status', async () => {
    const { registry } = buildRegistry();
    const t1 = await registry.createTicket('app-1', { subject: 'a', description: 'b' });
    await registry.createTicket('app-1', { subject: 'c', description: 'd' });
    await registry.updateTicket(t1.id, { status: 'closed' });

    const open = await registry.listTickets('open');
    const closed = await registry.listTickets('closed');
    expect(open).toHaveLength(1);
    expect(closed).toHaveLength(1);
  });

  it('rejects commenting on an unknown ticket', async () => {
    const { registry } = buildRegistry();
    await expect(registry.addTicketComment('nope', 'Rep', 'hi')).rejects.toThrow(CrmError);
  });
});
