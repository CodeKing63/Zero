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
  ): Promise<void> {
    const { db, conn } = createDbClient();
    try {
      await db.transaction(async (tx) => {
        // Authorization + existence check in one shot: this UPDATE returns
        // an empty array if the chat doesn't exist OR belongs to a different
        // connection. We use .returning() to detect the miss without a
        // separate SELECT round-trip.
        const updated = await tx
          .update(chats)
          .set({ updatedAt: new Date() })
          .where(and(eq(chats.connectionId, connectionId), eq(chats.id, chatId)))
          .returning({ id: chats.id });
        if (updated.length === 0) {
          throw new Error('Chat not found');
        }

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
