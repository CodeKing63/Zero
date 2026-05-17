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
