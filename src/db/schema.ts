import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * Enums
 */
export const oauthProviderEnum = pgEnum('oauth_provider', ['google', 'hubspot']);

export const messageRoleEnum = pgEnum('message_role', ['system', 'user', 'assistant', 'tool']);

export const taskStatusEnum = pgEnum('task_status', [
  'pending',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]);

export const taskStepKindEnum = pgEnum('task_step_kind', ['llm', 'tool', 'system']);

/**
 * USERS
 * Represents a person using the app (the advisor).
 */
export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),

    // Google email will be the primary identity.
    email: text('email').notNull(),

    name: text('name'),
    avatarUrl: text('avatar_url'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    emailUq: uniqueIndex('users_email_uq').on(t.email),
  }),
);

/**
 * OAUTH ACCOUNTS
 * Stores tokens for Google (Gmail/Calendar) and HubSpot.
 * NOTE: For the challenge we store tokens in plaintext.
 * In production you’d encrypt these at rest.
 */
export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: serial('id').primaryKey(),

    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    provider: oauthProviderEnum('provider').notNull(),

    /**
     * Google: use "sub" or the Google email as a stable identifier
     * HubSpot: use portalId / hubId or the connected account id
     */
    providerAccountId: text('provider_account_id').notNull(),

    // Helpful for debugging / UI display (optional)
    accountEmail: text('account_email'),

    accessToken: text('access_token').notNull(),
    refreshToken: text('refresh_token'),
    tokenType: text('token_type'),
    scope: text('scope'),

    expiresAt: timestamp('expires_at', { withTimezone: true }),

    // Store extra metadata if we need it later (portalId, etc.)
    meta: jsonb('meta'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('oauth_accounts_user_id_idx').on(t.userId),
    providerAccountUq: uniqueIndex('oauth_accounts_provider_account_uq').on(
      t.provider,
      t.providerAccountId,
    ),
  }),
);

/**
 * THREADS
 * A conversation container (ChatGPT-like threads).
 */
export const threads = pgTable(
  'threads',
  {
    id: serial('id').primaryKey(),

    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    title: text('title').notNull().default('New thread'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('threads_user_id_idx').on(t.userId),
  }),
);

/**
 * MESSAGES
 * Messages inside a thread.
 */
export const messages = pgTable(
  'messages',
  {
    id: serial('id').primaryKey(),

    threadId: integer('thread_id')
      .notNull()
      .references(() => threads.id, { onDelete: 'cascade' }),

    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    role: messageRoleEnum('role').notNull(),

    // For user/assistant: text content; for tool: could be tool output, etc.
    content: text('content').notNull(),

    // Optional structured data: tool calls, citations, etc.
    meta: jsonb('meta'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    threadIdIdx: index('messages_thread_id_idx').on(t.threadId),
    userIdIdx: index('messages_user_id_idx').on(t.userId),
  }),
);

/**
 * AGENT INSTRUCTIONS (memory)
 * Ongoing instructions like:
 * "When someone emails me that's not in HubSpot, create a contact..."
 */
export const agentInstructions = pgTable(
  'agent_instructions',
  {
    id: serial('id').primaryKey(),

    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    instruction: text('instruction').notNull(),

    isActive: boolean('is_active').notNull().default(true),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('agent_instructions_user_id_idx').on(t.userId),
    activeIdx: index('agent_instructions_is_active_idx').on(t.isActive),
  }),
);

/**
 * TASKS
 * Resumable “agent jobs” like scheduling a meeting.
 */
export const tasks = pgTable(
  'tasks',
  {
    id: serial('id').primaryKey(),

    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    status: taskStatusEnum('status').notNull().default('pending'),

    /**
     * A short machine-ish type. Examples:
     * - "schedule_meeting"
     * - "sync_gmail"
     * - "sync_hubspot"
     */
    type: text('type').notNull(),

    // Human-ish label shown in UI later
    title: text('title'),

    // Input arguments for the task (original user request, extracted entities, etc.)
    input: jsonb('input'),

    // Evolving task state (resumption) — what we “remember” for continuation.
    state: jsonb('state'),

    lastError: text('last_error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),

    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('tasks_user_id_idx').on(t.userId),
    statusIdx: index('tasks_status_idx').on(t.status),
    typeIdx: index('tasks_type_idx').on(t.type),
  }),
);

/**
 * TASK STEPS
 * A history log of what happened while executing a task:
 * - LLM decisions
 * - tool calls + outputs
 */
export const taskSteps = pgTable(
  'task_steps',
  {
    id: serial('id').primaryKey(),

    taskId: integer('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),

    stepIndex: integer('step_index').notNull(),

    kind: taskStepKindEnum('kind').notNull(),

    // e.g. "tool.sendEmail", "llm.plan", etc.
    name: text('name').notNull(),

    input: jsonb('input'),
    output: jsonb('output'),
    error: text('error'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    taskIdIdx: index('task_steps_task_id_idx').on(t.taskId),
    stepIndexUq: uniqueIndex('task_steps_task_id_step_index_uq').on(t.taskId, t.stepIndex),
  }),
);
