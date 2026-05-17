import { activeConnectionProcedure, router } from '../trpc';
import { ChatManager } from '../../lib/chat-manager';
import { TRPCError } from '@trpc/server';
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
    .input(z.object({ chatId: z.string().min(1), title: z.string().min(1).max(120) }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.chatManager.renameChat(ctx.connectionId, input.chatId, input.title);
      } catch (e) {
        if (e instanceof Error && e.message === 'Chat not found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Chat not found' });
        }
        throw e;
      }
    }),

  setPinned: chatsProcedure
    .input(z.object({ chatId: z.string().min(1), isPinned: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await ctx.chatManager.setPinned(ctx.connectionId, input.chatId, input.isPinned);
      } catch (e) {
        if (e instanceof Error && e.message === 'Chat not found') {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Chat not found' });
        }
        throw e;
      }
    }),

  delete: chatsProcedure
    .input(z.object({ chatId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      await ctx.chatManager.deleteChat(ctx.connectionId, input.chatId);
      return { ok: true as const };
    }),

  getMessages: chatsProcedure
    .input(z.object({ chatId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const chat = await ctx.chatManager.getChat(ctx.connectionId, input.chatId);
      if (!chat) throw new TRPCError({ code: 'NOT_FOUND', message: 'Chat not found' });
      return ctx.chatManager.getMessages(ctx.connectionId, input.chatId);
    }),
});
