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
