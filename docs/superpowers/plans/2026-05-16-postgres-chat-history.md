# Postgres-Backed Multi-Session Chat History — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace single-conversation, DO-SQLite-backed chat with multi-session chats stored in Postgres, including list/create/rename/pin/delete UI, auto-generated titles, and sidebar + fullscreen layouts.

**Architecture:** Two new Postgres tables (`mail0_chats`, `mail0_chat_messages`) accessed through a new `ChatManager` (used by both the `ZeroAgent` Durable Object and a new `chatsRouter` tRPC router). DO retains WebSocket/streaming/tool-execution responsibilities; storage moves to Postgres. Client uses tRPC for all chat lifecycle ops and the existing WS only for streaming the chat round-trip. `chatId` flows in the chat request body per-turn — DO is stateless w.r.t. chat identity.

**Tech Stack:** Drizzle ORM (Postgres via Hyperdrive), tRPC + TanStack Query, Cloudflare Agents SDK (`AIChatAgent`), React + nuqs URL state, Vercel AI SDK (`generateText` for titles, existing `streamText` flow for chats).

**Spec:** [`docs/superpowers/specs/2026-05-16-postgres-chat-history-design.md`](../specs/2026-05-16-postgres-chat-history-design.md)

**Testing posture:** Per spec, no automated tests in v1. Each task ends with a concrete manual verification step. Add tests later if needed.

**Branch:** Already on `chat-history`. All commits land here.

---

## Files Created / Modified

**Created:**
- `apps/server/src/lib/chat-manager.ts` — `ChatManager` class encapsulating all chat / chat_messages queries.
- `apps/server/src/lib/generate-chat-title.ts` — async title generation helper.
- `apps/server/src/trpc/routes/chats.ts` — tRPC router for chat lifecycle.
- `apps/mail/components/create/chat-list.tsx` — list panel (queries chats, handles row clicks, empty state).
- `apps/mail/components/create/chat-list-row.tsx` — single row with title, kebab menu (rename/pin/delete), active styling.

**Modified:**
- `apps/server/src/db/schema.ts` — add `chats` and `chatMessages` table definitions.
- `apps/server/src/trpc/index.ts` — register `chatsRouter` under key `chats`.
- `apps/server/src/routes/agent/index.ts` — override `ZeroAgent.persistMessages` to write Postgres; route `chatId` from request body; remove `ChatClear` handler.
- `apps/mail/components/ui/ai-sidebar.tsx` — manage `chatId` URL state, switch `useAgentChat` to tRPC-backed `getInitialMessages`, integrate `ChatList`, render layout for sidebar/fullscreen modes.
- `apps/mail/components/create/ai-chat.tsx` — accept `chatId` prop; rendered with `key={chatId}` so chat-switch unmounts and remounts.

---

## Task 1: Add `chats` and `chat_messages` to Drizzle schema

**Files:**
- Modify: `apps/server/src/db/schema.ts` (append to end)

- [ ] **Step 1: Add schema definitions**

Read `apps/server/src/db/schema.ts` to confirm imports (`pgTableCreator`, `text`, `timestamp`, `boolean`, `jsonb`, `index`, `createTable`).

Append to the end of `apps/server/src/db/schema.ts`:

```ts
// ---- Chat history ------------------------------------------------------

export const chats = createTable(
  'chats',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    connectionId: text('connection_id')
      .notNull()
      .references(() => connection.id, { onDelete: 'cascade' }),
    title: text('title').notNull().default('New chat'),
    isPinned: boolean('is_pinned').notNull().default(false),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (t) => [index('chats_connection_id_idx').on(t.connectionId, t.isPinned, t.updatedAt)],
);

export const chatMessages = createTable(
  'chat_messages',
  {
    id: text('id').primaryKey(),
    chatId: text('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    message: jsonb('message').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (t) => [index('chat_messages_chat_id_idx').on(t.chatId, t.createdAt)],
);
```

Note: schema uses `text` PK rather than `uuid` PK so we can let crypto.randomUUID() generate at insert time without enabling the `pgcrypto` extension (Hyperdrive may not have it). UUID format is preserved in app code; DB just treats it as text — same approach the codebase already uses for `user.id`, `connection.id`, etc.

- [ ] **Step 2: Apply migration via the existing migrations container**

Run from repo root:

```bash
docker compose up -d --build migrations
```

Expected: container builds, runs `bun run db:push`, exits with code 0. Watch the log with:

```bash
docker compose logs migrations --tail=40
```

Look for `[✓] Changes applied` (drizzle-kit) or a clean exit with no error stack trace.

- [ ] **Step 3: Verify tables exist in Postgres**

```bash
docker compose exec db psql -U postgres -d zerodotemail -c "\dt mail0_chat*"
```

Expected output lists `mail0_chats` and `mail0_chat_messages`.

- [ ] **Step 4: Commit**

```bash
git add apps/server/src/db/schema.ts
git commit -m "$(cat <<'EOF'
Add chats and chat_messages tables for Postgres-backed chat history

Two new tables scoped per connection: chats (id, title, isPinned,
timestamps) and chat_messages (id, chatId, role, message jsonb,
createdAt). Cascade delete from chats to messages. Composite index on
(connectionId, isPinned, updatedAt) for the list query.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Create `ChatManager` class

**Files:**
- Create: `apps/server/src/lib/chat-manager.ts`

- [ ] **Step 1: Write the file**

Create `apps/server/src/lib/chat-manager.ts`:

```ts
import { and, desc, eq, sql } from 'drizzle-orm';
import { chats, chatMessages } from '../db/schema';
import { createDb } from '../db';
import { env } from '../env';
import type { Message } from 'ai';

export type Chat = typeof chats.$inferSelect;
export type ChatMessageRow = typeof chatMessages.$inferSelect;

function createDbClient() {
  return createDb(env.HYPERDRIVE.connectionString);
}

export class ChatManager {
  async listChats(connectionId: string): Promise<Chat[]> {
    const { db, conn } = createDbClient();
    try {
      return await db
        .select()
        .from(chats)
        .where(eq(chats.connectionId, connectionId))
        .orderBy(desc(chats.isPinned), desc(chats.updatedAt));
    } finally {
      await conn.end();
    }
  }

  async getChat(connectionId: string, chatId: string): Promise<Chat | null> {
    const { db, conn } = createDbClient();
    try {
      const [row] = await db
        .select()
        .from(chats)
        .where(and(eq(chats.connectionId, connectionId), eq(chats.id, chatId)))
        .limit(1);
      return row ?? null;
    } finally {
      await conn.end();
    }
  }

  async createChat(
    connectionId: string,
    opts: { title?: string } = {},
  ): Promise<Chat> {
    const { db, conn } = createDbClient();
    try {
      const [row] = await db
        .insert(chats)
        .values({
          connectionId,
          title: opts.title ?? 'New chat',
        })
        .returning();
      if (!row) throw new Error('Failed to create chat');
      return row;
    } finally {
      await conn.end();
    }
  }

  async renameChat(
    connectionId: string,
    chatId: string,
    title: string,
  ): Promise<Chat> {
    const { db, conn } = createDbClient();
    try {
      const [row] = await db
        .update(chats)
        .set({ title, updatedAt: new Date() })
        .where(and(eq(chats.connectionId, connectionId), eq(chats.id, chatId)))
        .returning();
      if (!row) throw new Error('Chat not found');
      return row;
    } finally {
      await conn.end();
    }
  }

  async setPinned(
    connectionId: string,
    chatId: string,
    isPinned: boolean,
  ): Promise<Chat> {
    const { db, conn } = createDbClient();
    try {
      const [row] = await db
        .update(chats)
        .set({ isPinned, updatedAt: new Date() })
        .where(and(eq(chats.connectionId, connectionId), eq(chats.id, chatId)))
        .returning();
      if (!row) throw new Error('Chat not found');
      return row;
    } finally {
      await conn.end();
    }
  }

  async deleteChat(connectionId: string, chatId: string): Promise<void> {
    const { db, conn } = createDbClient();
    try {
      await db
        .delete(chats)
        .where(and(eq(chats.connectionId, connectionId), eq(chats.id, chatId)));
    } finally {
      await conn.end();
    }
  }

  async getMessages(connectionId: string, chatId: string): Promise<Message[]> {
    const chat = await this.getChat(connectionId, chatId);
    if (!chat) return [];

    const { db, conn } = createDbClient();
    try {
      const rows = await db
        .select()
        .from(chatMessages)
        .where(eq(chatMessages.chatId, chatId))
        .orderBy(chatMessages.createdAt);
      return rows.map((r) => r.message as Message);
    } finally {
      await conn.end();
    }
  }

  async persistMessages(
    connectionId: string,
    chatId: string,
    messages: Message[],
  ): Promise<void> {
    const chat = await this.getChat(connectionId, chatId);
    if (!chat) throw new Error('Chat not found');

    const { db, conn } = createDbClient();
    try {
      await db.transaction(async (tx) => {
        await tx.delete(chatMessages).where(eq(chatMessages.chatId, chatId));
        if (messages.length > 0) {
          await tx.insert(chatMessages).values(
            messages.map((m, i) => ({
              id: m.id,
              chatId,
              role: m.role,
              message: m as unknown as object,
              createdAt: new Date(Date.now() + i),
            })),
          );
        }
        await tx
          .update(chats)
          .set({ updatedAt: new Date() })
          .where(eq(chats.id, chatId));
      });
    } finally {
      await conn.end();
    }
  }

  async clearMessages(connectionId: string, chatId: string): Promise<void> {
    const chat = await this.getChat(connectionId, chatId);
    if (!chat) return;
    const { db, conn } = createDbClient();
    try {
      await db.delete(chatMessages).where(eq(chatMessages.chatId, chatId));
    } finally {
      await conn.end();
    }
  }
}
```

**Why delete-all-then-insert in `persistMessages`?** The AI SDK gives us the full message list on every turn (including all prior history), not a delta. Replacing wholesale guarantees consistency without diff logic. Volume is small (a chat is dozens of messages, not millions), wrapped in a transaction. The `createdAt + i` offset preserves stable ordering for messages persisted in the same millisecond.

- [ ] **Step 2: Typecheck**

```bash
docker compose exec server bunx tsc --noEmit -p apps/server/tsconfig.json 2>&1 | grep -E "chat-manager"
```

Expected: no output (no errors in chat-manager.ts).

If Docker isn't running tsc cleanly, run from host:

```bash
cd apps/server && bunx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add apps/server/src/lib/chat-manager.ts
git commit -m "$(cat <<'EOF'
Add ChatManager for Postgres-backed chat persistence

Encapsulates CRUD on chats and chat_messages. Every method takes
connectionId and includes it in WHERE clauses as the security boundary.
persistMessages does delete+insert in a transaction to mirror the AI
SDK's full-history-per-turn contract.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Create `chatsRouter` tRPC router

**Files:**
- Create: `apps/server/src/trpc/routes/chats.ts`
- Modify: `apps/server/src/trpc/index.ts`

- [ ] **Step 1: Write the router**

Create `apps/server/src/trpc/routes/chats.ts`:

```ts
import { activeConnectionProcedure, router } from '../trpc';
import { ChatManager } from '../../lib/chat-manager';
import { z } from 'zod';

const chatsProcedure = activeConnectionProcedure.use(async ({ ctx, next }) => {
  return next({
    ctx: {
      ...ctx,
      chatManager: new ChatManager(),
      connectionId: ctx.activeConnection.id,
    },
  });
});

export const chatsRouter = router({
  list: chatsProcedure.query(async ({ ctx }) => {
    return ctx.chatManager.listChats(ctx.connectionId);
  }),

  create: chatsProcedure
    .input(z.object({ title: z.string().optional() }).optional())
    .mutation(async ({ ctx, input }) => {
      return ctx.chatManager.createChat(ctx.connectionId, {
        title: input?.title,
      });
    }),

  rename: chatsProcedure
    .input(z.object({ chatId: z.string(), title: z.string().min(1).max(120) }))
    .mutation(async ({ ctx, input }) => {
      return ctx.chatManager.renameChat(ctx.connectionId, input.chatId, input.title);
    }),

  setPinned: chatsProcedure
    .input(z.object({ chatId: z.string(), isPinned: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.chatManager.setPinned(ctx.connectionId, input.chatId, input.isPinned);
    }),

  delete: chatsProcedure
    .input(z.object({ chatId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.chatManager.deleteChat(ctx.connectionId, input.chatId);
      return { ok: true as const };
    }),

  getMessages: chatsProcedure
    .input(z.object({ chatId: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.chatManager.getMessages(ctx.connectionId, input.chatId);
    }),
});
```

- [ ] **Step 2: Register the router**

Modify `apps/server/src/trpc/index.ts`. Add the import and the entry. Keep alphabetical-ish order similar to the rest.

After `import { categoriesRouter } from './routes/categories';` add:

```ts
import { chatsRouter } from './routes/chats';
```

In the `appRouter` object, add `chats: chatsRouter,` next to `categories`:

```ts
export const appRouter = router({
  ai: aiRouter,
  bimi: bimiRouter,
  brain: brainRouter,
  categories: categoriesRouter,
  chats: chatsRouter,
  connections: connectionsRouter,
  cookiePreferences: cookiePreferencesRouter,
  // ... rest unchanged
});
```

- [ ] **Step 3: Sync types so the frontend sees the new router**

The repo has a `nizzy sync` script that propagates server types to the mail app. Run from repo root:

```bash
bun nizzy sync
```

Expected: completes without errors. Confirms the mail app's `trpc` types now include `trpc.chats.*`.

- [ ] **Step 4: Restart the server container**

```bash
docker compose up -d --build server
```

Wait for the container to come back up:

```bash
docker compose logs server --tail=20
```

Expected: `[wrangler:info] Ready on http://0.0.0.0:8787`.

- [ ] **Step 5: Smoke-test the list endpoint**

Open http://localhost:3000 in a browser, sign in, open DevTools Network tab, and trigger any tRPC call to confirm baseline auth works. Then in the browser console run:

```js
fetch('/api/trpc/chats.list?batch=1&input=' + encodeURIComponent('{"0":{"json":null,"meta":{"values":["undefined"]}}}'), { credentials: 'include' }).then(r => r.json()).then(console.log)
```

Expected: response `[{ result: { data: { json: [] } } }]` (empty list for this user, since no chats exist yet). If you get 401 or 500, check `docker compose logs server` for the actual error.

- [ ] **Step 6: Commit**

```bash
git add apps/server/src/trpc/routes/chats.ts apps/server/src/trpc/index.ts
git commit -m "$(cat <<'EOF'
Add chats tRPC router for chat lifecycle (list, create, rename, pin, delete, getMessages)

All procedures derive from activeConnectionProcedure and scope reads/writes
through ChatManager with connectionId enforcement.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: ZeroAgent overrides — Postgres persistence + chatId routing

**Files:**
- Modify: `apps/server/src/routes/agent/index.ts` (around `ZeroAgent` class, lines 1861–2214)

**Note:** Between this commit and Task 6's commit, the client still calls the SDK's stock paths and won't send `chatId`. The agent's defensive fallback (auto-create a "Default chat" if no `chatId` provided) keeps the system usable. Task 6 removes the dependency on the fallback.

- [ ] **Step 1: Read the current ZeroAgent class so you know what you're replacing**

Read `apps/server/src/routes/agent/index.ts` from line 1861 to 2214.

- [ ] **Step 2: Add the `chatId` extraction + ChatManager wiring to `UseChatRequest`**

In the `onMessage` handler's `case IncomingMessageType.UseChatRequest`, replace the destructuring + persist calls with chatId-aware versions.

Find:
```ts
const { messages, threadId, currentFolder, currentFilter } = JSON.parse(
  body as string,
) as {
  threadId: string;
  currentFolder: string;
  currentFilter: string;
  messages: Message[];
};
this.broadcastChatMessage(
  {
    type: OutgoingMessageType.ChatMessages,
    messages,
  },
  [connection.id],
);
await this.persistMessages(messages, [connection.id]);
```

Replace with:
```ts
const { messages, threadId, currentFolder, currentFilter, chatId: rawChatId } = JSON.parse(
  body as string,
) as {
  threadId: string;
  currentFolder: string;
  currentFilter: string;
  messages: Message[];
  chatId?: string;
};

const chatManager = new ChatManager();
const connectionId = this.name;
const chatId = rawChatId ?? (await chatManager.createChat(connectionId, { title: 'New chat' })).id;

await chatManager.persistMessages(connectionId, chatId, messages);
```

Note we **remove** the `broadcastChatMessage(ChatMessages)` call. Multi-tab sync deferred per spec.

- [ ] **Step 3: Update the assistant-response persist call to use chatId**

Find:
```ts
return this.tryCatchChat(async () => {
  const response = await this.onChatMessageWithContext(
    async ({ response }) => {
      const finalMessages = appendResponseMessages({
        messages,
        responseMessages: response.messages,
      });

      await this.persistMessages(finalMessages, [connection.id]);
      this.removeAbortController(chatMessageId);
    },
    threadId,
    currentFolder,
    currentFilter,
  );
```

Replace `await this.persistMessages(finalMessages, [connection.id]);` with:
```ts
await chatManager.persistMessages(connectionId, chatId, finalMessages);
```

`chatManager`, `connectionId`, and `chatId` are in scope from Step 2.

- [ ] **Step 4: Remove the `ChatClear` case**

Find:
```ts
case IncomingMessageType.ChatClear: {
  this.destroyAbortControllers();
  void this.sql`delete from cf_ai_chat_agent_messages`;
  this.messages = [];
  this.broadcastChatMessage(
    {
      type: OutgoingMessageType.ChatClear,
    },
    [connection.id],
  );
  break;
}
```

Delete the entire case. Client-driven deletion is now `trpc.chats.delete`.

- [ ] **Step 5: Remove the `ChatMessages` case (no longer needed)**

Find:
```ts
case IncomingMessageType.ChatMessages: {
  await this.persistMessages(data.messages, [connection.id]);
  break;
}
```

Delete it. The persist path is now `UseChatRequest` only.

- [ ] **Step 6: Add the import for `ChatManager`**

Near the other server lib imports at the top of the file:
```ts
import { ChatManager } from '../../lib/chat-manager';
```

- [ ] **Step 7: Typecheck**

```bash
cd apps/server && bunx tsc --noEmit 2>&1 | grep "routes/agent/index"
```

Expected: no output for `routes/agent/index.ts` (pre-existing errors elsewhere are not yours).

- [ ] **Step 8: Restart server and smoke-test**

```bash
docker compose up -d --build server
docker compose logs server --tail=20
```

Open http://localhost:3000, open AI sidebar, send a message. The agent will auto-create a "New chat" row (because the client hasn't been updated yet to send `chatId`). Verify:

```bash
docker compose exec db psql -U postgres -d zerodotemail -c "SELECT id, title, connection_id, updated_at FROM mail0_chats;"
docker compose exec db psql -U postgres -d zerodotemail -c "SELECT id, chat_id, role, created_at FROM mail0_chat_messages ORDER BY created_at;"
```

Expected: one chat row, several message rows linked to it.

- [ ] **Step 9: Commit**

```bash
git add apps/server/src/routes/agent/index.ts
git commit -m "$(cat <<'EOF'
Route ZeroAgent chat persistence to Postgres via ChatManager

Reads chatId from request body, falls back to auto-creating a chat if
absent (client compatibility during cutover, removed once Task 6 lands).
Removes ChatClear and ChatMessages WS handlers — lifecycle is now tRPC.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Build `ChatList` and `ChatListRow` components

**Files:**
- Create: `apps/mail/components/create/chat-list-row.tsx`
- Create: `apps/mail/components/create/chat-list.tsx`

These render isolated from the sidebar for now. Task 6 wires them in.

- [ ] **Step 1: Read existing patterns for kebab menu + inline rename**

Read `apps/mail/components/mail/note-panel.tsx` lines 240–320 to see how rename/delete/pin are wired against `trpc.notes.*` — the pattern to mirror.

- [ ] **Step 2: Write `ChatListRow`**

Create `apps/mail/components/create/chat-list-row.tsx`:

```tsx
import { Pin, MoreHorizontal, Pencil, Trash2, PinOff } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useTRPC } from '@/providers/query-provider';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, useRef, useEffect } from 'react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export interface ChatListRowProps {
  chat: { id: string; title: string; isPinned: boolean; updatedAt: Date | string };
  isActive: boolean;
  onClick: () => void;
  onDeleted: (id: string) => void;
}

export function ChatListRow({ chat, isActive, onClick, onDeleted }: ChatListRowProps) {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const [isRenaming, setIsRenaming] = useState(false);
  const [draft, setDraft] = useState(chat.title);
  const inputRef = useRef<HTMLInputElement>(null);

  const renameMutation = useMutation({
    ...trpc.chats.rename.mutationOptions(),
    onSuccess: () => qc.invalidateQueries({ queryKey: trpc.chats.list.queryKey() }),
  });
  const pinMutation = useMutation({
    ...trpc.chats.setPinned.mutationOptions(),
    onSuccess: () => qc.invalidateQueries({ queryKey: trpc.chats.list.queryKey() }),
  });
  const deleteMutation = useMutation({
    ...trpc.chats.delete.mutationOptions(),
    onSuccess: () => qc.invalidateQueries({ queryKey: trpc.chats.list.queryKey() }),
  });

  useEffect(() => {
    if (isRenaming) inputRef.current?.select();
  }, [isRenaming]);

  const commitRename = async () => {
    const next = draft.trim();
    setIsRenaming(false);
    if (!next || next === chat.title) {
      setDraft(chat.title);
      return;
    }
    await renameMutation.mutateAsync({ chatId: chat.id, title: next });
  };

  const handleDelete = async () => {
    if (!confirm(`Delete "${chat.title}"? This can't be undone.`)) return;
    await deleteMutation.mutateAsync({ chatId: chat.id });
    onDeleted(chat.id);
  };

  return (
    <div
      onClick={onClick}
      className={cn(
        'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        isActive
          ? 'bg-[#f0f0f0] dark:bg-[#252525]'
          : 'hover:bg-[#f6f6f6] dark:hover:bg-[#1f1f1f]',
      )}
    >
      {chat.isPinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />}

      {isRenaming ? (
        <Input
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            if (e.key === 'Escape') {
              setDraft(chat.title);
              setIsRenaming(false);
            }
          }}
          className="h-6 px-1 py-0 text-sm"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="flex-1 truncate">{chat.title}</span>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild onClick={(e) => e.stopPropagation()}>
          <button className="opacity-0 group-hover:opacity-100 focus:opacity-100">
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
          <DropdownMenuItem onSelect={() => setIsRenaming(true)}>
            <Pencil className="mr-2 h-3.5 w-3.5" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() =>
              pinMutation.mutate({ chatId: chat.id, isPinned: !chat.isPinned })
            }
          >
            {chat.isPinned ? (
              <>
                <PinOff className="mr-2 h-3.5 w-3.5" /> Unpin
              </>
            ) : (
              <>
                <Pin className="mr-2 h-3.5 w-3.5" /> Pin
              </>
            )}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={handleDelete} className="text-red-600">
            <Trash2 className="mr-2 h-3.5 w-3.5" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
```

- [ ] **Step 3: Write `ChatList`**

Create `apps/mail/components/create/chat-list.tsx`:

```tsx
import { useTRPC } from '@/providers/query-provider';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChatListRow } from './chat-list-row';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface ChatListProps {
  activeChatId: string | null;
  onSelectChat: (id: string) => void;
  /** Optional header content rendered above the list (e.g. back button in narrow mode) */
  header?: React.ReactNode;
}

export function ChatList({ activeChatId, onSelectChat, header }: ChatListProps) {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const { data: chats = [], isLoading } = useQuery(trpc.chats.list.queryOptions());

  const createMutation = useMutation({
    ...trpc.chats.create.mutationOptions(),
    onSuccess: async (chat) => {
      await qc.invalidateQueries({ queryKey: trpc.chats.list.queryKey() });
      onSelectChat(chat.id);
    },
  });

  const handleDeleted = (deletedId: string) => {
    if (deletedId !== activeChatId) return;
    const remaining = chats.filter((c) => c.id !== deletedId);
    if (remaining.length > 0) {
      onSelectChat(remaining[0]!.id);
    } else {
      createMutation.mutate(undefined);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-2 py-2">
        {header ?? <span className="text-sm font-medium">Chats</span>}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => createMutation.mutate(undefined)}
          className="h-7 w-7 p-0"
        >
          <Plus className="h-4 w-4" />
          <span className="sr-only">New chat</span>
        </Button>
      </div>
      <div className="flex-1 overflow-y-auto px-1">
        {isLoading ? (
          <div className="px-2 py-1 text-xs text-muted-foreground">Loading…</div>
        ) : chats.length === 0 ? (
          <div className="px-2 py-3 text-xs text-muted-foreground">
            No chats yet. Tap + to start one.
          </div>
        ) : (
          chats.map((chat) => (
            <ChatListRow
              key={chat.id}
              chat={chat}
              isActive={chat.id === activeChatId}
              onClick={() => onSelectChat(chat.id)}
              onDeleted={handleDeleted}
            />
          ))
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck mail app**

```bash
cd apps/mail && bunx tsc --noEmit 2>&1 | grep -E "chat-list"
```

Expected: no errors in `chat-list.tsx` or `chat-list-row.tsx`. (Other pre-existing errors are not yours.)

- [ ] **Step 5: Commit**

```bash
git add apps/mail/components/create/chat-list.tsx apps/mail/components/create/chat-list-row.tsx
git commit -m "$(cat <<'EOF'
Add ChatList and ChatListRow components

ChatList renders the chats query result, "+ new chat" mutation, and
empty/loading states. ChatListRow has inline rename, kebab menu for
pin/unpin/delete, and active-row styling. Not yet wired into the sidebar.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Refactor `AISidebar` for chatId lifecycle + layout switch

**Files:**
- Modify: `apps/mail/components/ui/ai-sidebar.tsx`
- Modify: `apps/mail/components/create/ai-chat.tsx`

This is the biggest task. Sub-steps land it incrementally.

- [ ] **Step 1: Make `AIChat` accept and use `chatId`**

In `apps/mail/components/create/ai-chat.tsx`, find the existing `AIChat` function signature near the top:

```tsx
export function AIChat({
  messages,
  setInput,
  error,
  handleSubmit,
  status,
}: ReturnType<typeof useAgentChat>): React.ReactElement {
```

We don't need to change `AIChat` itself — `chatId` will be injected at the `useAgentChat` call site in `AISidebar`, and the active chat switch is handled by `key={chatId}` on the component. No edit to `ai-chat.tsx` is required here. Move on.

- [ ] **Step 2: Extract the existing `useAgentChat` block in `AISidebar` into a child component keyed on `chatId`**

In `apps/mail/components/ui/ai-sidebar.tsx`, add at the top imports:

```tsx
import { ChatList } from '@/components/create/chat-list';
import { Menu, ArrowLeft } from 'lucide-react';
```

Above the existing `AISidebar` function (or in a sibling file — keeping inline for now), add a new `ActiveChat` component that wraps `useAgent` + `useAgentChat` + `AIChat`. This is where `chatId` enters.

```tsx
function ActiveChat({ chatId, connectionId }: { chatId: string; connectionId: string }) {
  const queryClient = useQueryClient();
  const trpc = useTRPC();
  const [threadId] = useQueryState('threadId');
  const { folder } = useParams<{ folder: string }>();
  const { refetch: refetchLabels } = useLabels();
  const [searchValue] = useSearchValue();
  const [, setDoState] = useDoState();
  const { labels } = useSearchLabels();
  const { track, refetch: refetchBilling } = useBilling();

  const onMessage = useCallback(
    (message: any) => {
      try {
        const parsedData = JSON.parse(message.data);
        const { type } = parsedData;
        if (type === IncomingMessageType.Mail_Get) {
          const { threadId } = parsedData;
          queryClient.invalidateQueries({
            queryKey: trpc.mail.get.queryKey({ id: threadId }),
          });
        } else if (type === IncomingMessageType.Mail_List) {
          const { folder } = parsedData;
          queryClient.invalidateQueries({
            queryKey: trpc.mail.listThreads.infiniteQueryKey({
              folder,
              labelIds: labels,
              q: searchValue.value,
            }),
          });
        } else if (type === IncomingMessageType.User_Topics) {
          queryClient.invalidateQueries({
            queryKey: trpc.labels.list.queryKey(),
          });
        } else if (type === IncomingMessageType.Do_State) {
          const { isSyncing, syncingFolders, storageSize, counts, shards } = parsedData;
          setDoState({ isSyncing, syncingFolders, storageSize, counts: counts ?? [], shards });
        }
      } catch (error) {
        console.error('error parsing party message', error, { rawMessage: message.data });
      }
    },
    [queryClient, trpc, labels, searchValue.value, setDoState],
  );

  const agent = useAgent({
    agent: 'ZeroAgent',
    name: connectionId,
    host: `${import.meta.env.VITE_PUBLIC_BACKEND_URL}`,
    onError: (e) => console.log(e),
    onMessage,
  });

  const chatState = useAgentChat({
    agent,
    maxSteps: 10,
    credentials: 'include',
    body: {
      chatId,
      threadId: threadId ?? undefined,
      currentFolder: folder ?? undefined,
      currentFilter: searchValue.value ?? undefined,
    },
    getInitialMessages: async () =>
      (await queryClient.fetchQuery(
        trpc.chats.getMessages.queryOptions({ chatId }),
      )) as any,
    onError(error) {
      console.error('Error in useChat', error);
      posthog.capture('AI Chat Error', {
        error: error.message,
        chatId,
        threadId: threadId ?? undefined,
        currentFolder: folder ?? undefined,
        currentFilter: searchValue.value ?? undefined,
        messages: chatState.messages,
      });
      toast.error('Error, please try again later');
    },
    onResponse: (response) => {
      posthog.capture('AI Chat Response', {
        response,
        chatId,
        threadId: threadId ?? undefined,
        currentFolder: folder ?? undefined,
        currentFilter: searchValue.value ?? undefined,
        messages: chatState.messages,
      });
      if (!response.ok) {
        throw new Error('Failed to send message');
      }
    },
    async onToolCall({ toolCall }) {
      console.warn('toolCall', toolCall);
      posthog.capture('AI Chat Tool Call', {
        toolCall,
        chatId,
        threadId: threadId ?? undefined,
        currentFolder: folder ?? undefined,
        currentFilter: searchValue.value ?? undefined,
        messages: chatState.messages,
      });
      switch (toolCall.toolName) {
        case Tools.CreateLabel:
        case Tools.DeleteLabel:
          await refetchLabels();
          break;
        case Tools.SendEmail:
          await queryClient.invalidateQueries({
            queryKey: trpc.mail.listThreads.queryKey({ folder: 'sent' }),
          });
          break;
        case Tools.MarkThreadsRead:
        case Tools.MarkThreadsUnread:
        case Tools.ModifyLabels:
        case Tools.BulkDelete:
          await refetchLabels();
          await Promise.all(
            (toolCall.args as { threadIds: string[] }).threadIds.map((id) =>
              queryClient.invalidateQueries({
                queryKey: trpc.mail.get.queryKey({ id }),
              }),
            ),
          );
          break;
      }
      await track({ featureId: 'chat-messages', value: 1 });
      await refetchBilling();
    },
  });

  return <AIChat {...chatState} />;
}
```

- [ ] **Step 3: Add a `useChatId` hook**

Inside the same file, above `AISidebar`:

```tsx
function useChatId() {
  const [chatId, setChatIdQuery] = useQueryState('chatId');
  const setChatId = useCallback(
    (id: string | null) => setChatIdQuery(id),
    [setChatIdQuery],
  );
  return [chatId, setChatId] as const;
}
```

- [ ] **Step 4: Rewrite the main `AISidebar` body to manage chatId + render layout**

Inside the `AISidebar` function, **replace** the existing `useAgent`/`useAgentChat`/`handleNewChat`/render block with a chatId-driven version.

Replace from the `const onMessage = useCallback(...)` block through the end of `handleNewChat` with:

```tsx
const [chatId, setChatId] = useChatId();
const [view, setView] = useState<'chat' | 'list'>('chat');
const { data: chats = [] } = useQuery(trpc.chats.list.queryOptions());
const createMutation = useMutation({
  ...trpc.chats.create.mutationOptions(),
  onSuccess: async (chat) => {
    await queryClient.invalidateQueries({ queryKey: trpc.chats.list.queryKey() });
    setChatId(chat.id);
    setView('chat');
  },
});

// Auto-select / auto-create on mount and whenever chatId becomes stale.
useEffect(() => {
  if (!activeConnection?.id) return;
  if (chatId && chats.some((c) => c.id === chatId)) return; // valid
  if (chats.length > 0) {
    setChatId(chats[0]!.id);
  } else if (!createMutation.isPending) {
    createMutation.mutate(undefined);
  }
}, [chatId, chats, activeConnection?.id]);

const handleNewChat = useCallback(() => {
  createMutation.mutate(undefined);
}, [createMutation]);
```

- [ ] **Step 5: Update the render to switch between chat view and list view**

Replace `<AIChat {...chatState} />` in both the sidebar-mode and popup/fullscreen JSX blocks with the new layout selector. Define a helper just above the `return`:

```tsx
const chatPane =
  chatId && activeConnection?.id ? (
    <ActiveChat key={chatId} chatId={chatId} connectionId={String(activeConnection.id)} />
  ) : (
    <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
      Loading chat…
    </div>
  );

const listPane = (
  <ChatList
    activeChatId={chatId}
    onSelectChat={(id) => {
      setChatId(id);
      setView('chat');
    }}
    header={
      <button
        onClick={() => setView('chat')}
        className="flex items-center gap-1 text-sm font-medium"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> Chats
      </button>
    }
  />
);
```

In the **sidebar mode** branch (`isSidebar && !isFullScreen`), replace `<AIChat {...chatState} />` with:

```tsx
{view === 'list' ? listPane : chatPane}
```

In the **popup / fullscreen** branch, change the inner layout from a single `<AIChat />` to a horizontal split:

```tsx
<div className="flex h-full">
  {/* Left rail */}
  <div className="hidden w-60 shrink-0 border-r border-[#E7E7E7] md:flex md:flex-col dark:border-[#252525]">
    <ChatList
      activeChatId={chatId}
      onSelectChat={(id) => setChatId(id)}
    />
  </div>
  {/* Active chat */}
  <div className="flex-1">{chatPane}</div>
</div>
```

- [ ] **Step 6: Update `ChatHeader` to expose the list toggle in sidebar mode**

Add a `view` and `onToggleView` prop to `ChatHeaderProps`. In the header JSX, add (before the existing `Plus` "+" button):

```tsx
<TooltipProvider delayDuration={0}>
  <Tooltip>
    <TooltipTrigger asChild>
      <Button onClick={onToggleView} variant="ghost" className="md:h-fit md:px-2">
        {view === 'list' ? (
          <ArrowLeft className="dark:text-iconDark text-iconLight h-4 w-4" />
        ) : (
          <Menu className="dark:text-iconDark text-iconLight h-4 w-4" />
        )}
        <span className="sr-only">{view === 'list' ? 'Back to chat' : 'Show chats'}</span>
      </Button>
    </TooltipTrigger>
    <TooltipContent>{view === 'list' ? 'Back to chat' : 'Show chats'}</TooltipContent>
  </Tooltip>
</TooltipProvider>
```

Pass `view` and `onToggleView={() => setView(v => v === 'list' ? 'chat' : 'list')}` from `AISidebar` to `ChatHeader` in both render sites. Only render this toggle in sidebar mode (omit in fullscreen, since the rail is always visible there).

- [ ] **Step 7: Restart mail container**

```bash
docker compose up -d --build mail
docker compose logs mail --tail=15
```

Expected: `[wrangler:info] Ready on http://0.0.0.0:3000`.

- [ ] **Step 8: Manual smoke test**

Open http://localhost:3000:
1. Open the AI sidebar — should auto-land in a (newly created) chat.
2. Send a message → response streams back.
3. Click `+` → creates a new chat, switches to it.
4. Click `☰` → list view appears with both chats.
5. Click an old chat row → returns to that chat, previous messages load.
6. Refresh page → still on the same chat (chatId persists via URL).
7. Toggle fullscreen — left rail appears with all chats.

Look for any TypeScript errors in the browser console or Wrangler log.

- [ ] **Step 9: Commit**

```bash
git add apps/mail/components/ui/ai-sidebar.tsx apps/mail/components/create/ai-chat.tsx
git commit -m "$(cat <<'EOF'
Wire AISidebar to multi-chat: chatId URL state, ChatList integration, layout switch

Adds ActiveChat child component keyed on chatId so chat-switch
unmounts/remounts cleanly. Loads history via trpc.chats.getMessages.
Sidebar mode: in-panel toggle between list and chat. Fullscreen / popup:
permanent left rail with active chat on the right. Auto-creates a chat
on first open and falls back gracefully when the URL chatId is stale.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Add async title generation

**Files:**
- Create: `apps/server/src/lib/generate-chat-title.ts`
- Modify: `apps/server/src/lib/chat-manager.ts`

- [ ] **Step 1: Write the title generator**

Create `apps/server/src/lib/generate-chat-title.ts`:

```ts
import { generateText } from 'ai';
import { openai } from './llm';
import { env } from '../env';
import type { Message } from 'ai';

function plainText(m: Message): string {
  const parts = m.parts ?? [];
  return parts
    .map((p) => ('text' in p ? p.text : ''))
    .filter(Boolean)
    .join(' ')
    .trim();
}

export async function generateChatTitle(messages: Message[]): Promise<string | null> {
  const firstUser = messages.find((m) => m.role === 'user');
  const firstAssistant = messages.find((m) => m.role === 'assistant');
  if (!firstUser || !firstAssistant) return null;

  const userText = plainText(firstUser).slice(0, 500);
  const assistantText = plainText(firstAssistant).slice(0, 500);
  if (!userText) return null;

  try {
    const { text } = await generateText({
      model: openai(env.OPENAI_MINI_MODEL || 'gpt-4o-mini'),
      messages: [
        {
          role: 'system',
          content:
            'Generate a 3 to 6 word title for this conversation. Be specific and descriptive. No quotes, no punctuation.',
        },
        {
          role: 'user',
          content: `User: ${userText}\nAssistant: ${assistantText}`,
        },
      ],
    });
    const cleaned = text.trim().replace(/^["']|["']$/g, '').slice(0, 80);
    return cleaned || null;
  } catch (err) {
    console.warn('[generateChatTitle] failed', err);
    return null;
  }
}
```

- [ ] **Step 2: Wire it into `ChatManager.persistMessages`**

Modify `apps/server/src/lib/chat-manager.ts`. Add import at top:

```ts
import { generateChatTitle } from './generate-chat-title';
```

Change `persistMessages` to accept an optional `waitUntil` and trigger title gen:

```ts
async persistMessages(
  connectionId: string,
  chatId: string,
  messages: Message[],
  waitUntil?: (p: Promise<unknown>) => void,
): Promise<void> {
  const chat = await this.getChat(connectionId, chatId);
  if (!chat) throw new Error('Chat not found');

  const { db, conn } = createDbClient();
  try {
    await db.transaction(async (tx) => {
      await tx.delete(chatMessages).where(eq(chatMessages.chatId, chatId));
      if (messages.length > 0) {
        await tx.insert(chatMessages).values(
          messages.map((m, i) => ({
            id: m.id,
            chatId,
            role: m.role,
            message: m as unknown as object,
            createdAt: new Date(Date.now() + i),
          })),
        );
      }
      await tx
        .update(chats)
        .set({ updatedAt: new Date() })
        .where(eq(chats.id, chatId));
    });
  } finally {
    await conn.end();
  }

  // Title gen — fire-and-forget if still default and we have both sides.
  const hasUser = messages.some((m) => m.role === 'user');
  const hasAssistant = messages.some((m) => m.role === 'assistant');
  if (chat.title === 'New chat' && hasUser && hasAssistant) {
    const task = (async () => {
      const title = await generateChatTitle(messages);
      if (!title) return;
      const { db: db2, conn: conn2 } = createDbClient();
      try {
        await db2
          .update(chats)
          .set({ title })
          .where(and(eq(chats.id, chatId), eq(chats.title, 'New chat')));
      } finally {
        await conn2.end();
      }
    })();
    if (waitUntil) {
      waitUntil(task);
    } else {
      // Best-effort even outside a waitUntil context.
      task.catch((e) => console.warn('[chat-title] background task error', e));
    }
  }
}
```

- [ ] **Step 3: Pass `waitUntil` from the agent's persist call**

In `apps/server/src/routes/agent/index.ts`, find the two `chatManager.persistMessages(...)` calls added in Task 4, Step 2 and Step 3. Update them to pass `this.ctx.waitUntil.bind(this.ctx)`:

Step 2's call becomes:
```ts
await chatManager.persistMessages(connectionId, chatId, messages, this.ctx.waitUntil.bind(this.ctx));
```

Step 3's call becomes:
```ts
await chatManager.persistMessages(connectionId, chatId, finalMessages, this.ctx.waitUntil.bind(this.ctx));
```

The tRPC route does **not** pass `waitUntil` — chats are never created in user-triggered tRPC mutations with messages, so this path won't trigger title gen in practice. The `.catch()` fallback in `persistMessages` keeps things safe.

- [ ] **Step 4: Restart server and verify**

```bash
docker compose up -d --build server
docker compose logs server --tail=15
```

In the browser, create a new chat, send a message ("How do I label github emails as OSS?"). Wait ~3 seconds for the response, then a moment longer for title gen. Check Postgres:

```bash
docker compose exec db psql -U postgres -d zerodotemail -c "SELECT id, title, updated_at FROM mail0_chats ORDER BY updated_at DESC LIMIT 5;"
```

Expected: the most recent chat's `title` changed from `'New chat'` to something specific (e.g., `'Label GitHub emails OSS'`).

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/generate-chat-title.ts apps/server/src/lib/chat-manager.ts apps/server/src/routes/agent/index.ts
git commit -m "$(cat <<'EOF'
Auto-generate chat titles via cheap LLM call after first turn

Title gen fires inside ChatManager.persistMessages when title is still
'New chat' and both user + assistant messages have landed. Uses
ctx.waitUntil to outlive the request. Idempotent UPDATE prevents
races with manual rename.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Client-side title-refresh trigger

**Files:**
- Modify: `apps/mail/components/ui/ai-sidebar.tsx`

Title gen is server-async — the client needs to know when to refetch `chats.list` so the new title appears.

- [ ] **Step 1: Add the trigger in `ActiveChat`**

In `apps/mail/components/ui/ai-sidebar.tsx`'s `ActiveChat` component, add a `useEffect` that invalidates `chats.list` when streaming completes and we're still showing the default title.

Right before the `return <AIChat {...chatState} />` line:

```tsx
const titleStillDefault = useQuery(trpc.chats.list.queryOptions()).data?.find(
  (c) => c.id === chatId,
)?.title === 'New chat';

const prevStatus = useRef(chatState.status);
useEffect(() => {
  if (
    prevStatus.current === 'streaming' &&
    chatState.status === 'ready' &&
    titleStillDefault
  ) {
    // Let the server finish the title gen before refetching.
    const timer = setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: trpc.chats.list.queryKey() });
    }, 1500);
    return () => clearTimeout(timer);
  }
  prevStatus.current = chatState.status;
}, [chatState.status, titleStillDefault, queryClient, trpc]);
```

Add `useRef` to the existing `react` import at the top of the file if not already present.

- [ ] **Step 2: Restart mail container**

```bash
docker compose up -d --build mail
```

- [ ] **Step 3: Manual verification**

Open http://localhost:3000:
1. Open AI sidebar, hit "+" for a new chat. Title shows "New chat".
2. Send a message, wait for assistant response.
3. Open chat list (`☰`). Within ~2 seconds the title in the list should update to the generated title.

- [ ] **Step 4: Commit**

```bash
git add apps/mail/components/ui/ai-sidebar.tsx
git commit -m "$(cat <<'EOF'
Refetch chats.list after first turn so the generated title appears

Watches useAgentChat's status transition from streaming to ready;
when the active chat still has the default title, invalidate the list
query after a short delay so server-side title gen has time to finish.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Manual end-to-end verification

**Files:** None — this is a verification checklist against the spec.

Run these checks in a clean browser session against the running Docker stack.

- [ ] **Step 1: Connection isolation**

1. Sign in with mailbox A. Create 2 chats with distinct titles.
2. Sign out, sign in with mailbox B.
3. Open AI sidebar. Expected: mailbox B's chat list does NOT show any of A's chats.
4. Create 1 chat in B with a distinct title.
5. Switch back to mailbox A. Expected: still see A's 2 chats, not B's chat.

Confirm in DB:
```bash
docker compose exec db psql -U postgres -d zerodotemail -c "SELECT connection_id, count(*) FROM mail0_chats GROUP BY connection_id;"
```

- [ ] **Step 2: Lifecycle, sidebar mode**

In sidebar mode:
- Open `+` to create a new chat. Send a message.
- Kebab menu → Rename. Type a new title, hit Enter. Verify it persists after refresh.
- Kebab menu → Pin. Verify the row jumps to the top of the list.
- Kebab menu → Unpin. Verify it falls back to time-sorted position.
- Kebab menu → Delete. Confirm the dialog. Verify the chat disappears AND another chat becomes active (or a new one is auto-created if list became empty).
- Open `☰` toggle. Click another chat. Verify it loads with prior messages.
- Click `☰` back arrow / chat row. Verify return to active chat.

- [ ] **Step 3: Lifecycle, fullscreen mode**

Toggle fullscreen. Repeat checks from Step 2 using the persistent left rail. Verify:
- The active chat is highlighted in the rail.
- Switching from the rail loads instantly.
- "+ New chat" in the rail header creates and switches.

- [ ] **Step 4: URL state survives reload**

With an active chat, refresh the page. Expected: same chat is active, message history is loaded. Check the URL — `?chatId=…` should be present.

- [ ] **Step 5: Stale chatId recovery**

Copy a chat's id, delete that chat, paste the stale `?chatId=<deleted>` URL. Expected: the app silently falls through to the most recent chat or auto-creates one. No error toast.

- [ ] **Step 6: No DO SQLite writes**

```bash
docker compose exec server wrangler d1 execute --local <id> --command "SELECT count(*) FROM cf_ai_chat_agent_messages;" 2>&1 || true
```

(That `wrangler d1` invocation may not be configured for this DO — alternative check: search agent logs for `delete from cf_ai_chat_agent_messages` and confirm no calls.)

```bash
docker compose logs server --since=10m | grep -i "cf_ai_chat_agent_messages" || echo "OK: no DO SQLite chat writes"
```

Expected: `OK: no DO SQLite chat writes`.

- [ ] **Step 7: Title generation**

Create a fresh chat with a specific question ("Summarize the last email from Stripe"). Wait for the response. Wait an additional 5 seconds. Open the chat list. Expected: title is a 3–6 word summary, not "New chat".

- [ ] **Step 8: Final commit (if needed) and tag**

If all checks pass with no code changes needed, this task is a no-op for commits. Otherwise, commit any fixes:

```bash
git add -A
git commit -m "$(cat <<'EOF'
Fix issues found during chat history E2E verification

[describe the specific fixes]

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

When the branch is verified, surface the result to the user — they decide whether to PR it.

---

## Self-review summary (run before handoff)

Cross-checked against spec sections:

| Spec section | Plan coverage |
|---|---|
| Schema (`chats`, `chat_messages`) | Task 1 |
| `ChatManager` API | Task 2 |
| tRPC routes (`list`/`create`/`rename`/`setPinned`/`delete`/`getMessages`) | Task 3 |
| DO override of `persistMessages`, removal of `ChatClear` | Task 4 |
| `chatId` per-request body flow | Task 4 step 2, Task 6 step 2 |
| `getInitialMessages` via tRPC | Task 6 step 2 |
| `ChatList`, kebab menu, auto-select / create | Tasks 5 & 6 |
| Sidebar in-panel toggle + fullscreen left rail | Task 6 steps 5–6 |
| Title gen (LLM, idempotent UPDATE, ctx.waitUntil) | Task 7 |
| Client title-refresh trigger | Task 8 |
| Cutover (single deploy, migration container) | Tasks 1, 4, 6 land in order; no phased rollout needed |
| Risks (connection isolation, stale chatId, no multi-tab) | Task 9 manual checks |
| Manual E2E as v1 test bar | Task 9 |

No placeholders. All file paths absolute or repo-relative. All code blocks complete. No "similar to Task N" — each task is self-contained.

---

**Plan complete and saved to `docs/superpowers/plans/2026-05-16-postgres-chat-history.md`. Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
