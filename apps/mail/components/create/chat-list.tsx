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
