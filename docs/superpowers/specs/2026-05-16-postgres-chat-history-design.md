# Postgres-backed multi-session chat history

**Status:** Approved design
**Date:** 2026-05-16
**Owner:** Ali Bahar

## Background

The AI chat sidebar in the mail app supports exactly one persistent conversation per mailbox. History is stored in Cloudflare Durable Object SQLite (`cf_ai_chat_agent_messages`) by the Cloudflare Agents SDK's `AIChatAgent` base class. The "+" button wipes that single conversation; there is no concept of named chat sessions, no way to switch between past conversations, and no UI for browsing prior work.

Users want **topic-specific chats** — for example, a chat about Q1 OKRs that references specific email threads, kept separate from a chat about recruiting backlog that references different threads. Today that is impossible: starting a new topic destroys the prior one.

In parallel, the choice of DO SQLite for storage adds no real value over the project's existing Postgres database: chat data is per-user, append-only, never joined across users, and Postgres is already part of the stack with Drizzle ORM, tRPC routing, and migration infrastructure in place. Moving to Postgres unlocks queryability, durability guarantees consistent with the rest of the system, and a single source of truth.

## Goals

- Multi-session chats per mailbox, each with a title, pinned state, and creation/update timestamps.
- All chat persistence in Postgres; DO SQLite no longer used for chat messages.
- UI for listing, switching, renaming, pinning, and deleting chats.
- Auto-generated chat titles (LLM-derived from the first turn), with manual rename.
- Single deploy cutover — no migration of existing DO chat data.

## Non-goals (explicit v1 deferrals)

- Search across chats (title + message body).
- Custom labels / topics on chats (no chat-tagging UI in v1).
- Per-chat model selector.
- Drag-to-reorder chats (pin is the only sort lever).
- Cross-tab real-time sync (React Query's window-focus refetch is acceptable).
- Migration of existing DO SQLite chat data into Postgres.
- Removal of the now-unused `cf_ai_chat_agent_messages` DO SQLite table (left in place as a rollback escape hatch).
- Keyboard navigation through the chat list.

## Naming

The codebase already uses "thread" to mean a *Gmail thread* (`threadId`, `getThread`, `ThreadPreview`). To avoid collision, chat sessions are called **chats** throughout: `chats` and `chat_messages` tables; `chatId`, `useChats()`, `ChatList` in code.

## Architecture overview

```
┌────────────────────┐         ┌──────────────────────┐         ┌──────────────────┐
│ Mail app (browser) │         │ ZeroAgent DO         │         │ Postgres         │
│                    │         │ (per connectionId)   │         │                  │
│  useAgentChat      │ ─WS───▶ │  onChatMessage       │ ──────▶ │  chats           │
│   body: { chatId } │         │   (LLM + tools)      │         │  chat_messages   │
│                    │         │  persistMessages →   │         │                  │
│  ChatList          │ ─tRPC──▶│  ChatManager         │ ──────▶ │                  │
│   chats.list       │         │                      │         │                  │
│   chats.create     │         │                      │         │                  │
│   chats.rename     │         │                      │         │                  │
│   chats.setPinned  │         │                      │         │                  │
│   chats.delete     │         │                      │         │                  │
│   chats.getMessages│ ────────────tRPC─────────────────────────▶                  │
└────────────────────┘         └──────────────────────┘         └──────────────────┘
```

The DO stays — it owns the WebSocket session, tool execution, LLM streaming, and per-mailbox state. What changes is *where* messages are persisted: from `this.sql` (DO SQLite) to Postgres via a new `ChatManager`. `chatId` flows in the chat request body on every turn; the DO is request-scoped stateless with respect to chat identity.

The client uses tRPC for all chat lifecycle operations (list, create, rename, pin, delete, getMessages) and the existing WebSocket only for the actual streaming chat round-trip.

## Schema

Added to `apps/server/src/db/schema.ts`. Applied through the existing `migrations` container (`docker-compose.yaml:48`), which runs `bun run db:push` — picks up schema changes automatically, no separate `drizzle-kit generate` step needed for this dev/pre-prod environment.

### `chats`

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK DEFAULT `gen_random_uuid()` | Server-generated on insert. |
| `connectionId` | `text` FK → `connection.id`, ON DELETE CASCADE | Scopes chats per mailbox. Matches existing DO keying. |
| `title` | `text` NOT NULL DEFAULT `'New chat'` | LLM-generated after first turn; manually renameable. |
| `isPinned` | `boolean` NOT NULL DEFAULT `false` | Pinned chats sort above the rest. |
| `createdAt` | `timestamptz` NOT NULL DEFAULT `now()` | |
| `updatedAt` | `timestamptz` NOT NULL DEFAULT `now()` | Bumped on every persisted message; used for sort. |

Index: `(connectionId, isPinned DESC, updatedAt DESC)` — single index scan for the list query.

### `chat_messages`

| Column | Type | Notes |
|---|---|---|
| `id` | `text` PK | The AI SDK's own message id (preserves streaming → persisted mapping). |
| `chatId` | `uuid` FK → `chats.id`, ON DELETE CASCADE | |
| `role` | `text` NOT NULL | `'user' \| 'assistant' \| 'system' \| 'tool'`. |
| `message` | `jsonb` NOT NULL | Full AI SDK `Message` (parts, tool invocations, attachments). Schema-flexible. |
| `createdAt` | `timestamptz` NOT NULL DEFAULT `now()` | Tiebreak ordering within a chat. |

Index: `(chatId, createdAt)`.

**Why `jsonb` for the full message?** AI SDK message shape evolves between SDK versions, and we don't query *into* tool invocations in v1 (no search, no analytics). When that's needed, a generated column or side-table backfill is straightforward.

## Storage layer

### `ChatManager` (`apps/server/src/lib/chat-manager.ts`)

New file, follows the `NotesManager` pattern. Encapsulates all `chats` / `chat_messages` queries so the DO and the tRPC router both call into one place.

```ts
class ChatManager {
  constructor(private db: ZeroDb) {}

  // List
  listChats(connectionId): Promise<Chat[]>                       // pinned desc, updatedAt desc
  getChat(connectionId, chatId): Promise<Chat | null>

  // Lifecycle
  createChat(connectionId, opts?: { title?: string }): Promise<Chat>
  renameChat(connectionId, chatId, title): Promise<Chat>
  setPinned(connectionId, chatId, isPinned): Promise<Chat>
  deleteChat(connectionId, chatId): Promise<void>                // cascades messages

  // Messages — used by the agent
  getMessages(connectionId, chatId): Promise<Message[]>          // hydrate AI SDK Message[]
  persistMessages(connectionId, chatId, messages): Promise<void> // bumps chats.updatedAt; triggers title gen
  clearMessages(connectionId, chatId): Promise<void>             // chat row stays
}
```

**Security boundary:** every method takes `connectionId` as a required argument and includes it in the WHERE clause. A request for `chatId=X` against the wrong `connectionId` returns null / zero rows. No method derives `connectionId` from anywhere other than the caller.

### tRPC router (`apps/server/src/trpc/routes/chats.ts`)

Registered in `apps/server/src/trpc/index.ts` under key `chats`.

```ts
export const chatsRouter = router({
  list:        chatsProcedure.query(...)                                   // → Chat[]
  create:      chatsProcedure.input({ title?: string }).mutation(...)      // → Chat
  rename:      chatsProcedure.input({ chatId, title }).mutation(...)       // → Chat
  setPinned:   chatsProcedure.input({ chatId, isPinned }).mutation(...)    // → Chat
  delete:      chatsProcedure.input({ chatId }).mutation(...)              // → { ok: true }
  getMessages: chatsProcedure.input({ chatId }).query(...)                 // → AiMessage[]
});
```

`chatsProcedure` is `privateProcedure` extended with middleware that resolves the active connection from session and attaches `ctx.chatManager` and `ctx.connectionId`. Mirrors the pattern used in `notes.ts`.

**Why a tRPC `getMessages` instead of the SDK's `/get-messages` HTTP endpoint?** The Agents SDK's `/get-messages` is hard-coded to read `cf_ai_chat_agent_messages` from DO SQLite. To repurpose it we'd need to override `onRequest` on the DO, parse query string for `chatId`, and route to a different store. tRPC already does all of that cleanly with end-to-end types. The HTTP endpoint becomes dead code post-cutover.

## DO / agent rewiring

The DO (`ZeroAgent` in `apps/server/src/routes/agent/index.ts`) stays — it owns:

- WebSocket session + cookie auth (`agentsMiddleware` in `main.ts:818`).
- Tool execution (everything in `apps/server/src/routes/agent/tools.ts`).
- LLM streaming via the AI SDK.
- Per-mailbox state (DO state cache, sync flags) keyed by `connectionId`.

What changes:

| Today | After |
|---|---|
| `persistMessages(messages, exclude)` writes to `cf_ai_chat_agent_messages` SQLite. | Override → `ChatManager.persistMessages(connectionId, chatId, messages)` → Postgres. Also keeps `this.messages = messages` in memory for the current turn's LLM context. |
| `onMessage` `ChatClear` handler runs `delete from cf_ai_chat_agent_messages`. | Removed entirely. Chat lifecycle is now tRPC mutations. |
| `onMessage` `ChatMessages` handler persists to SQL + broadcasts. | Persists to Postgres for `chatId`. Broadcast removed for v1 (see multi-tab sync risk). |
| `onRequest('/get-messages')` reads SQLite. | Removed — client uses `trpc.chats.getMessages`. |

DO SQLite table `cf_ai_chat_agent_messages` is left untouched (the base class creates it at boot regardless). It becomes a no-op rollback escape hatch.

### `chatId` flow — per-request stateless

No new "switch chat" WS message type, and the DO does not track "current chat" in memory.

1. Client sends `chatId` in the chat request body alongside existing `threadId`, `currentFolder`, `currentFilter`:
   ```ts
   useAgentChat({
     body: { chatId, threadId, currentFolder, currentFilter },
     getInitialMessages: () => trpc.chats.getMessages.query({ chatId }),
   })
   ```
2. Server's `onChatMessageWithContext` reads `chatId` from `data.body` on every request.
3. All persist/load calls thread `chatId` through. The DO is a stateless message processor between Postgres and the LLM.

**Why stateless?** Two reasons. First, the React component is keyed on `chatId` — switching chats unmounts and remounts, naturally re-running `getInitialMessages` without any server-side "switch" round-trip. Second, if a user has multiple tabs chatting in different chats against the same DO, request-scoped `chatId` prevents one tab's chat from polluting the other's persistence.

### Postgres access from the DO

Uses the existing `getZeroDB(connectionId)` pattern from `apps/server/src/lib/server-utils.ts:542`. Already proven to work from DO context (workflows use it). No new infrastructure.

## Frontend

### State model

| State | Where | Why |
|---|---|---|
| Active `chatId` | `useQueryState('chatId')` (nuqs URL state) | Survives reload, shareable as deep link. |
| Sidebar view mode (chat vs. list) | Local React state in `AISidebar` | Resets when panel closes — natural UX. |
| Fullscreen / popup mode | Existing `useQueryState('isFullScreen')`, `viewMode` | Unchanged. |

### Component layout

```
apps/mail/components/create/
├─ ai-chat.tsx          (existing — minor edits: accept chatId prop, used as key)
├─ chat-list.tsx        (new — the list, auto-select / auto-create on mount)
└─ chat-list-row.tsx    (new — one row, kebab menu for rename / pin / delete)

apps/mail/components/ui/
└─ ai-sidebar.tsx       (refactored — owns layout switch + chatId lifecycle)
```

### Sidebar mode (narrow right rail)

```
┌──────────────────────────┐
│ × [☰] [+]                │   header: close, toggle list, new chat
├──────────────────────────┤
│  chat messages           │
│  ...                     │
│  [type a message...]     │
└──────────────────────────┘
```

Tapping `☰` replaces chat-view with the list (full panel width):

```
┌──────────────────────────┐
│ ← Chats           [+]    │
├──────────────────────────┤
│ 📌 Q1 OKRs               │   pinned, sorted first
│    Re: Acme proposal     │
│    Recruiting backlog    │
│    ...                   │
└──────────────────────────┘
```

Tapping a row flips back to chat-view with that `chatId` selected.

### Fullscreen / popup mode

Persistent ~240px left rail with list and active chat visible at once:

```
┌──────────────┬─────────────────────────────────┐
│ Chats   [+]  │ ×                       [↗] [⛶] │
├──────────────┼─────────────────────────────────┤
│ 📌 Q1 OKRs   │  chat messages                  │
│  Re: Acme    │                                 │
│  Recruiting  │  [type a message...]            │
└──────────────┴─────────────────────────────────┘
```

### `ChatList` behavior

- Query: `trpc.chats.list.useQuery()` — sorted server-side `(isPinned DESC, updatedAt DESC)`.
- Click row → `setChatId(row.id)` → `<AIChat key={chatId} />` remounts → `getInitialMessages` re-runs.
- Active row has accent background.
- Hover reveals kebab (`•••`). Menu: **Rename**, **Pin / Unpin**, **Delete**.
- Rename: inline edit on the row, confirms on Enter or blur.
- Delete: confirm dialog. If deleted chat was active, select next chat in the list (or create one if list is now empty).
- Pin: toggle pin, optimistic update.

### Auto-select / create on mount

1. If `?chatId=…` in URL → use it.
2. If that id doesn't resolve (deleted, wrong connection) → fall through to step 3.
3. Load `chats.list`. If non-empty → select first row (most recent). If empty → call `chats.create`, select the new row.

Net effect: opening the AI sidebar always puts you into *a* chat. Matches current behavior — no degraded empty state.

### `AIChat` component edits

Minimal:

- Accept `chatId: string` prop.
- `useAgentChat({ body: { chatId, ... }, getInitialMessages: () => trpc.chats.getMessages.query({ chatId }) })`.
- Rendered as `<AIChat key={chatId} chatId={chatId} ... />` in `AISidebar` — React unmount/remount handles chat-switch with no extra logic.

### Mutations & cache

| Mutation | Invalidates |
|---|---|
| `create` | `chats.list` |
| `rename` | `chats.list` (optimistic update) |
| `setPinned` | `chats.list` (optimistic update) |
| `delete` | `chats.list`, `chats.getMessages` for that id |

### Title generation feedback

When `useAgentChat`'s `status` transitions `'streaming'` → `'ready'` and the active chat's title is `'New chat'`, invalidate `chats.list` once. One refetch per first-message, scoped — no polling.

## Title generation

### Trigger

Inside `ChatManager.persistMessages`, after the row write succeeds, check if:

1. Chat title is still `'New chat'`, AND
2. The persisted messages include both a user message and an assistant message.

If so, fire-and-forget a title-gen task without awaiting:

```ts
if (chat.title === 'New chat' && hasUserAndAssistantMessage(messages)) {
  ctx.waitUntil(generateAndSaveTitle(chatId, messages));
}
```

`ctx.waitUntil` keeps the DO alive past the request so the title gen completes after the chat response has already returned.

### Prompt and model

Use whatever cheap model the project's existing `apps/server/src/trpc/routes/ai/` paths use (likely a `gpt-4o-mini`-class model) — do not introduce a new provider.

```
Generate a 3-6 word title for this conversation. Be specific and descriptive.
No quotes, no punctuation.

User: <first user message, truncated to 500 chars>
Assistant: <first assistant message, truncated to 500 chars>
```

### Idempotency

```sql
UPDATE chats SET title = $1 WHERE id = $2 AND title = 'New chat'
```

If the user manually renamed in the meantime, or two persists raced, the no-match UPDATE is a safe no-op.

### Failure mode

If the LLM call errors, swallow + log. The chat keeps `'New chat'` until a future persist re-attempts on the next message round, OR the user renames manually. No inline retry.

### Cost guard

None for v1. The call is sub-cent and bounded to once-per-chat. If spam becomes a problem, add a per-connection rate limit backed by Valkey.

## Cutover

One deploy, four ordered steps:

1. **DB migration.** Edit `apps/server/src/db/schema.ts` to add the two tables. Apply through the existing `migrations` container in `docker-compose.yaml:48` (runs `bun run db:push`). Additive only — two new tables, no changes to existing tables. Zero risk to existing data.

2. **Server.** Deploy new `ZeroAgent` overrides, `ChatManager`, and `chatsRouter`. Remove the old `/get-messages` HTTP endpoint and the `ChatClear` WS handler in the same deploy (dead code once the client stops calling them).

3. **Client.** Deploy new `AISidebar`, `ChatList`, `ChatListRow`, and the `useAgentChat` wiring. First load post-deploy: `chats.list` returns empty for everyone, auto-create kicks in, user lands in a fresh chat.

4. **DO SQLite leftover.** `cf_ai_chat_agent_messages` rows from before cutover are stranded but cost essentially nothing. Optional follow-up: a one-line cleanup in the DO `alarm()` to reclaim the bytes. Not required.

### Rollback

Single command: redeploy the previous server + client images together. Postgres tables stay (additive, no data loss). Worst case: users lose any chats created during the new-version window.

## Risks

1. **Cross-mailbox leakage.** Every `ChatManager` method must filter `WHERE connectionId = $current`. A missed clause leaks another user's chats. *Mitigation:* `connectionId` is a required positional argument on every method; a manual test verifies wrong-connection lookups return empty.

2. **`chatId` race within a connection.** Two tabs sending messages in different chats. The DO reads `chatId` per-request and persists keyed by that id with no DO-side "current chat" state, so there's no cross-chat pollution. Cosmetic risk only: each tab sees only its own outgoing messages until window-focus refetch.

3. **Stale `chatId` in URL after deletion in another tab.** Loading a deleted-or-foreign chatId returns null. `ChatList` falls through to "select most recent" — same code path as no-chatId. Silent recovery, no error toast.

4. **Title generation runaway cost.** Bounded by cheap model + once-per-chat. Acceptable for v1.

5. **DO message broadcast removed.** Multi-tab sync degrades. Documented as a known v1 limitation. React Query's `refetchOnWindowFocus` covers the common case (switching browser tabs).

## Testing

Manual end-to-end testing is the v1 bar. The two highest-leverage checks before merge:

- **Connection isolation.** Sign in with two different mailboxes, create chats in each, verify they don't appear in each other's list.
- **Lifecycle.** Create → rename → pin → switch → delete → auto-select fallback → "+ new chat", in both sidebar mode and fullscreen mode.

If unit tests on `ChatManager` and the tRPC router are desired, fold into the implementation plan as a separate step.
