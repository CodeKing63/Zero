import { and, desc, eq, sql } from 'drizzle-orm';
import { chats, chatMessages } from '../db/schema';
import { createDb } from '../db';
import { env } from '../env';
import { generateChatTitle } from './generate-chat-title';
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
    const { db, conn } = createDbClient();
    try {
      const rows = await db
        .select({ message: chatMessages.message })
        .from(chatMessages)
        .innerJoin(chats, eq(chatMessages.chatId, chats.id))
        .where(and(eq(chats.connectionId, connectionId), eq(chats.id, chatId)))
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
    waitUntil?: (p: Promise<unknown>) => void,
  ): Promise<void> {
    const { db, conn } = createDbClient();
    let priorTitle: string | null = null;
    try {
      await db.transaction(async (tx) => {
        // Authorization + existence check in one shot: this UPDATE returns
        // an empty array if the chat doesn't exist OR belongs to a different
        // connection. We use .returning() to detect the miss without a
        // separate SELECT round-trip, and capture the prior title to decide
        // whether to trigger background title generation.
        const updated = await tx
          .update(chats)
          .set({ updatedAt: new Date() })
          .where(and(eq(chats.connectionId, connectionId), eq(chats.id, chatId)))
          .returning({ id: chats.id, title: chats.title });
        if (updated.length === 0) {
          throw new Error('Chat not found');
        }
        priorTitle = updated[0]!.title;

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
      });
    } finally {
      await conn.end();
    }

    // Title gen — fire-and-forget if still default and we have both sides.
    const hasUser = messages.some((m) => m.role === 'user');
    const hasAssistant = messages.some((m) => m.role === 'assistant');
    if (priorTitle === 'New chat' && hasUser && hasAssistant) {
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
        waitUntil(task.catch((e) => console.warn('[chat-title] waitUntil task error', e)));
      } else {
        task.catch((e) => console.warn('[chat-title] background task error', e));
      }
    }
  }

  async clearMessages(connectionId: string, chatId: string): Promise<void> {
    const { db, conn } = createDbClient();
    try {
      // Inline ownership check via correlated subquery so the DELETE only
      // affects messages whose parent chat belongs to this connection.
      await db.delete(chatMessages).where(
        and(
          eq(chatMessages.chatId, chatId),
          sql`exists (select 1 from ${chats} where ${chats.id} = ${chatId} and ${chats.connectionId} = ${connectionId})`,
        ),
      );
    } finally {
      await conn.end();
    }
  }
}
