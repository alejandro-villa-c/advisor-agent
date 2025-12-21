import {
  boolean,
  customType,
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
 * RAG / Documents
 */
export const documentSourceEnum = pgEnum('document_source', [
  'hubspot_contact',
  'hubspot_note',
  'gmail_email',
  'calendar_event',
]);

/**
 * pgvector column type helper for Drizzle
 * Stores vectors as pgvector's `vector(n)` type.
 *
 * NOTE: We set 1536 dims by default (common for many embedding models).
 * If you later change embedding model dimensions, you’ll need a migration.
 */
export const vector = customType<{
  data: number[];
  driverData: string;
  config?: { dimensions: number };
}>({
  dataType: (config) => `vector(${config?.dimensions ?? 1536})`,
  toDriver: (value) => {
    // pgvector accepts strings like: '[0.1,0.2,0.3]'
    return `[${value.join(',')}]`;
  },
  fromDriver: (value) => {
    if (typeof value !== 'string') return [];
    const trimmed = value.trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return [];
    const inner = trimmed.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((x) => Number(x.trim()));
  },
});

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

export const integrationKindEnum = pgEnum('integration_kind', [
  'gmail',
  'calendar',
  'hubspot_notes',
  'hubspot_contacts',
]);

export const integrationStates = pgTable(
  'integration_states',
  {
    id: serial('id').primaryKey(),

    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    integration: integrationKindEnum('integration').notNull(),

    /**
     * Provider-specific cursor/state.
     * Gmail: { historyId, lastSyncedAt, labelIds?, query?, pageToken? }
     * Calendar: { syncToken, lastSyncedAt, calendarId? }
     * HubSpot: { lastSyncedAt, ... }
     */
    state: jsonb('state').notNull().default({}),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('integration_states_user_id_idx').on(t.userId),
    userIntegrationUq: uniqueIndex('integration_states_user_integration_uq').on(
      t.userId,
      t.integration,
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

/**
 * HUBSPOT CONTACTS (local mirror)
 * This is the stable ingestion layer for HubSpot → RAG.
 */
export const hubspotContacts = pgTable(
  'hubspot_contacts',
  {
    id: serial('id').primaryKey(),

    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    hubspotContactId: text('hubspot_contact_id').notNull(),

    email: text('email'),
    firstName: text('first_name'),
    lastName: text('last_name'),

    raw: jsonb('raw'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('hubspot_contacts_user_id_idx').on(t.userId),
    emailIdx: index('hubspot_contacts_email_idx').on(t.email),
    userContactUq: uniqueIndex('hubspot_contacts_user_contact_uq').on(t.userId, t.hubspotContactId),
  }),
);

/**
 * HUBSPOT NOTES (local mirror)
 */
export const hubspotNotes = pgTable(
  'hubspot_notes',
  {
    id: serial('id').primaryKey(),

    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    hubspotNoteId: text('hubspot_note_id').notNull(),
    hubspotContactId: text('hubspot_contact_id').notNull(),

    body: text('body'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),

    raw: jsonb('raw'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('hubspot_notes_user_id_idx').on(t.userId),
    contactIdx: index('hubspot_notes_user_contact_idx').on(t.userId, t.hubspotContactId),
    userNoteUq: uniqueIndex('hubspot_notes_user_note_uq').on(t.userId, t.hubspotNoteId),
  }),
);

/**
 * DOCUMENTS
 * Generic normalized text units that feed chunking + embeddings.
 */
export const documents = pgTable(
  'documents',
  {
    id: serial('id').primaryKey(),

    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    source: documentSourceEnum('source').notNull(),
    sourceId: text('source_id').notNull(),

    title: text('title'),
    text: text('text').notNull(),

    meta: jsonb('meta'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('documents_user_id_idx').on(t.userId),
    sourceIdx: index('documents_source_idx').on(t.source),
    userSourceUq: uniqueIndex('documents_user_source_uq').on(t.userId, t.source, t.sourceId),
  }),
);

/**
 * DOCUMENT CHUNKS
 * Chunked text + embeddings for similarity search.
 *
 * Embedding is nullable for now; we’ll backfill via a worker job later.
 */
export const documentChunks = pgTable(
  'document_chunks',
  {
    id: serial('id').primaryKey(),

    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    documentId: integer('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),

    chunkIndex: integer('chunk_index').notNull(),
    text: text('text').notNull(),

    embedding: vector('embedding', { dimensions: 1536 }),

    embeddingModel: text('embedding_model'),

    meta: jsonb('meta'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('document_chunks_user_id_idx').on(t.userId),
    documentIdIdx: index('document_chunks_document_id_idx').on(t.documentId),
    docChunkUq: uniqueIndex('document_chunks_document_chunk_uq').on(t.documentId, t.chunkIndex),
  }),
);

export const gmailMessages = pgTable(
  'gmail_messages',
  {
    id: serial('id').primaryKey(),

    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    gmailMessageId: text('gmail_message_id').notNull(),
    gmailThreadId: text('gmail_thread_id'),

    from: text('from'),
    to: text('to'),
    cc: text('cc'),
    bcc: text('bcc'),

    subject: text('subject'),
    snippet: text('snippet'),

    /**
     * Gmail internalDate is ms since epoch; we store as timestamptz for querying.
     */
    sentAt: timestamp('sent_at', { withTimezone: true }),

    /**
     * Raw Gmail payload (or the subset you keep).
     */
    raw: jsonb('raw'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('gmail_messages_user_id_idx').on(t.userId),
    threadIdx: index('gmail_messages_thread_id_idx').on(t.gmailThreadId),
    sentAtIdx: index('gmail_messages_sent_at_idx').on(t.sentAt),
    userMsgUq: uniqueIndex('gmail_messages_user_msg_uq').on(t.userId, t.gmailMessageId),
  }),
);

export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: serial('id').primaryKey(),

    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    calendarId: text('calendar_id').notNull().default('primary'),
    googleEventId: text('google_event_id').notNull(),

    summary: text('summary'),
    description: text('description'),
    location: text('location'),

    startAt: timestamp('start_at', { withTimezone: true }),
    endAt: timestamp('end_at', { withTimezone: true }),

    attendees: jsonb('attendees'),
    raw: jsonb('raw'),

    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    userIdIdx: index('calendar_events_user_id_idx').on(t.userId),
    startIdx: index('calendar_events_start_at_idx').on(t.startAt),
    userEventUq: uniqueIndex('calendar_events_user_event_uq').on(
      t.userId,
      t.calendarId,
      t.googleEventId,
    ),
  }),
);

export const agentTaskStatusEnum = pgEnum('agent_task_status', [
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
]);

export const agentTasks = pgTable('agent_tasks', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),

  status: agentTaskStatusEnum('status').notNull().default('queued'),
  goal: text('goal').notNull(),

  // Agent memory / working state (LLM-visible)
  memory: jsonb('memory').notNull().default({}),

  // When waiting: { kind: 'gmail_reply', threadId: '...', fromEmail: '...', sinceIso: '...' }
  waiting: jsonb('waiting'),

  lastError: text('last_error'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agentTaskMessages = pgTable('agent_task_messages', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id').notNull(),
  userId: integer('user_id').notNull(),

  // 'system' | 'user' | 'assistant' | 'tool'
  role: text('role').notNull(),
  content: text('content').notNull(),

  // Tool message metadata (optional)
  toolName: text('tool_name'),
  toolCallId: text('tool_call_id'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const agentTaskToolCalls = pgTable('agent_task_tool_calls', {
  id: serial('id').primaryKey(),
  taskId: integer('task_id').notNull(),
  userId: integer('user_id').notNull(),

  toolName: text('tool_name').notNull(),
  toolCallId: text('tool_call_id').notNull(),

  input: jsonb('input').notNull(),
  output: jsonb('output'),
  status: text('status').notNull(), // 'ok' | 'error' | 'await'
  error: text('error'),

  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
