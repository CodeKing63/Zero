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
import { toast } from 'sonner';
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
    onError: () => toast.error('Failed to delete chat'),
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
    // eslint-disable-next-line no-alert
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
