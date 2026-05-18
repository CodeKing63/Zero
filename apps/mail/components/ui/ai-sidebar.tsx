import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from '@/components/ui/tooltip';
import { ArrowsPointingIn, PanelLeftOpen, Phone } from '../icons/icons';
import { useActiveConnection } from '@/hooks/use-connections';
import { ResizablePanel } from '@/components/ui/resizable';
import { useSearchValue } from '@/hooks/use-search-value';
import { useState, useEffect, useCallback } from 'react';
import useSearchLabels from '@/hooks/use-labels-search';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AIChat } from '@/components/create/ai-chat';
import { ChatList } from '@/components/create/chat-list';
import { useTRPC } from '@/providers/query-provider';
import { Tools } from '../../../server/src/types';
import { useDoState } from '../mail/use-do-state';
import { useBilling } from '@/hooks/use-billing';
import { PromptsDialog } from './prompts-dialog';
import { Button } from '@/components/ui/button';
import { useHotkeys } from 'react-hotkeys-hook';
import { useLabels } from '@/hooks/use-labels';
import { useAgentChat } from 'agents/ai-react';
import { X, Expand, Plus, Menu, ArrowLeft } from 'lucide-react';
import { IncomingMessageType } from '../party';
import { useParams } from 'react-router';
import { useAgent } from 'agents/react';
import { useQueryState } from 'nuqs';
import { cn } from '@/lib/utils';
import posthog from 'posthog-js';
import { toast } from 'sonner';

interface ChatHeaderProps {
  onClose: () => void;
  onToggleFullScreen: () => void;
  onToggleViewMode: () => void;
  isFullScreen: boolean;
  isPopup: boolean;
  onNewChat: () => void;
  view?: 'chat' | 'list';
  onToggleView?: () => void;
}

function ChatHeader({
  onClose,
  onToggleFullScreen,
  onToggleViewMode,
  isFullScreen,
  isPopup,
  onNewChat,
  view,
  onToggleView,
}: ChatHeaderProps) {
  return (
    <div className="relative flex items-center justify-between px-2.5 pb-[10px] pt-[13px]">
      <TooltipProvider delayDuration={0}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button onClick={onClose} variant="ghost" className="md:h-fit md:px-2">
              <X className="dark:text-iconDark text-iconLight" />
              <span className="sr-only">Close chat</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Close chat</TooltipContent>
        </Tooltip>
      </TooltipProvider>

      <div className="flex items-center gap-2">
        {isFullScreen ? (
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  onClick={onToggleFullScreen}
                  variant="ghost"
                  className="hidden md:flex md:h-fit md:px-2"
                >
                  <ArrowsPointingIn className="dark:fill-iconDark fill-iconLight" />
                  <span className="sr-only">Toggle view mode</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>Remove full screen</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          <>
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={onToggleFullScreen}
                    variant="ghost"
                    className="hidden md:flex md:h-fit md:px-2"
                  >
                    <Expand className="dark:text-iconDark text-iconLight" />
                    <span className="sr-only">Toggle view mode</span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Go to full screen</TooltipContent>
              </Tooltip>
            </TooltipProvider>

            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    onClick={onToggleViewMode}
                    variant="ghost"
                    className="hidden md:flex md:h-fit md:px-2"
                  >
                    {isPopup ? (
                      <PanelLeftOpen className="dark:fill-iconDark fill-iconLight" />
                    ) : (
                      <Phone className="dark:fill-iconDark fill-iconLight" />
                    )}
                    <span className="sr-only"></span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Go to {isPopup ? 'sidebar' : 'popup'}</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </>
        )}

        {onToggleView && (
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button onClick={onToggleView} variant="ghost" className="md:h-fit md:px-2">
                  {view === 'list' ? (
                    <ArrowLeft className="dark:text-iconDark text-iconLight h-4 w-4" />
                  ) : (
                    <Menu className="dark:text-iconDark text-iconLight h-4 w-4" />
                  )}
                  <span className="sr-only">
                    {view === 'list' ? 'Back to chat' : 'Show chats'}
                  </span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>{view === 'list' ? 'Back to chat' : 'Show chats'}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        <PromptsDialog />

        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button onClick={onNewChat} variant="ghost" className="md:h-fit md:px-2">
                <Plus className="dark:text-iconDark text-iconLight" />
                <span className="sr-only">New chat</span>
              </Button>
            </TooltipTrigger>
            <TooltipContent>New chat</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
    </div>
  );
}

interface AISidebarProps {
  className?: string;
}

type ViewMode = 'sidebar' | 'popup' | 'fullscreen';

export function useAIFullScreen() {
  const [isFullScreenQuery, setIsFullScreenQuery] = useQueryState('isFullScreen');

  // Initialize isFullScreen state from query parameter or localStorage
  const [isFullScreen, setIsFullScreenState] = useState<boolean>(() => {
    // First check query parameter
    if (isFullScreenQuery) {
      return isFullScreenQuery === 'true';
    }

    // Then check localStorage if on client
    if (typeof window !== 'undefined') {
      const savedFullScreen = localStorage.getItem('ai-fullscreen');
      if (savedFullScreen) {
        return savedFullScreen === 'true';
      }
    }

    return false;
  });

  // Update both query parameter and localStorage when fullscreen state changes
  const setIsFullScreen = useCallback(
    (value: boolean) => {
      // Immediately update local state for faster UI response
      setIsFullScreenState(value);

      // For exiting fullscreen, we need to be extra careful to ensure state is updated properly
      if (!value) {
        // Force immediate removal from localStorage for faster response
        if (typeof window !== 'undefined') {
          localStorage.removeItem('ai-fullscreen');
        }

        // Use setTimeout to ensure the state update happens in the next tick
        // This helps prevent the need for double-clicking
        setTimeout(() => {
          setIsFullScreenQuery(null).catch(console.error);
        }, 0);
      } else {
        // For entering fullscreen, we can use the normal flow
        setIsFullScreenQuery('true').catch(console.error);

        // Save to localStorage for persistence across sessions
        if (typeof window !== 'undefined') {
          localStorage.setItem('ai-fullscreen', 'true');
        }
      }
    },
    [setIsFullScreenQuery],
  );

  // Sync with query parameter on mount or when it changes
  useEffect(() => {
    const queryValue = isFullScreenQuery === 'true';
    if (isFullScreenQuery !== null && queryValue !== isFullScreen) {
      setIsFullScreenState(queryValue);
    }
  }, [isFullScreenQuery, isFullScreen]);

  // Initialize from localStorage on mount if query parameter is not set
  useEffect(() => {
    if (typeof window !== 'undefined' && !isFullScreenQuery) {
      const savedFullScreen = localStorage.getItem('ai-fullscreen');
      if (savedFullScreen === 'true') {
        setIsFullScreenQuery('true');
      }
    }

    // Force a re-render when exiting fullscreen mode
    if (isFullScreenQuery === null && isFullScreen) {
      setIsFullScreenState(false);
    }
  }, [isFullScreenQuery, setIsFullScreenQuery, isFullScreen]);

  return {
    isFullScreen,
    setIsFullScreen,
  };
}

export function useAISidebar() {
  const [open, setOpenQuery] = useQueryState('aiSidebar');
  const [viewModeQuery, setViewModeQuery] = useQueryState('viewMode');
  const { isFullScreen, setIsFullScreen } = useAIFullScreen();

  // Initialize viewMode from query parameter, localStorage, or default to 'sidebar'
  const [viewMode, setViewModeState] = useState<ViewMode>(() => {
    if (viewModeQuery) return viewModeQuery as ViewMode;

    // Check localStorage for saved state if on client
    if (typeof window !== 'undefined') {
      const savedViewMode = localStorage.getItem('ai-viewmode');
      if (savedViewMode && (savedViewMode === 'sidebar' || savedViewMode === 'popup')) {
        return savedViewMode as ViewMode;
      }
    }

    return 'popup';
  });

  // Update query parameter and localStorage when viewMode changes
  const setViewMode = useCallback(
    (mode: ViewMode) => {
      setViewModeState(mode);
      setViewModeQuery(mode === 'popup' ? null : mode);

      // Save to localStorage for persistence across sessions
      if (typeof window !== 'undefined') {
        localStorage.setItem('ai-viewmode', mode);
      }
    },
    [setViewModeQuery],
  );

  const setOpen = useCallback(
    (openState: boolean) => {
      if (!openState) {
        if (typeof window !== 'undefined') {
          localStorage.removeItem('ai-sidebar-open');
        }
        setTimeout(() => {
          setOpenQuery(null).catch(console.error);
        }, 0);
      } else {
        setOpenQuery('true').catch(console.error);
        if (typeof window !== 'undefined') {
          localStorage.setItem('ai-sidebar-open', 'true');
        }
      }
    },
    [setOpenQuery],
  );

  const toggleOpen = useCallback(() => setOpen(open !== 'true'), [open, setOpen]);

  useEffect(() => {
    if (viewModeQuery && viewModeQuery !== viewMode) {
      setViewModeState(viewModeQuery as ViewMode);
    }
  }, [viewModeQuery, viewMode]);

  return {
    open: !!open,
    viewMode,
    setViewMode,
    setOpen,
    toggleOpen,
    toggleViewMode: () => setViewMode(viewMode === 'popup' ? 'sidebar' : 'popup'),
    isFullScreen,
    setIsFullScreen,
    // Add convenience boolean flags for each state
    isSidebar: viewMode === 'sidebar',
    isPopup: viewMode === 'popup',
  };
}

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

function useChatId() {
  const [chatId, setChatIdQuery] = useQueryState('chatId');
  const setChatId = useCallback(
    (id: string | null) => setChatIdQuery(id),
    [setChatIdQuery],
  );
  return [chatId, setChatId] as const;
}

function AISidebar({ className }: AISidebarProps) {
  const { open, setOpen, isFullScreen, setIsFullScreen, toggleViewMode, isSidebar, isPopup } =
    useAISidebar();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { data: activeConnection } = useActiveConnection();

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatId, chats, activeConnection?.id]);

  const handleNewChat = useCallback(() => {
    setView('chat');
    createMutation.mutate(undefined);
  }, [createMutation]);

  useHotkeys('Meta+0', () => {
    setOpen(!open);
  });

  const chatPane =
    chatId && activeConnection?.id ? (
      <ActiveChat key={chatId} chatId={chatId} connectionId={String(activeConnection.id)} />
    ) : (
      <div className="text-muted-foreground flex h-full items-center justify-center text-xs">
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

  return (
    <>
      {open && (
        <>
          {/* Desktop sidebar (narrow right rail) */}
          {isSidebar && !isFullScreen && (
            <>
              <div className="w-px opacity-0" />
              <ResizablePanel
                defaultSize={24}
                minSize={24}
                maxSize={24}
                className="bg-panelLight dark:bg-panelDark mb-1 mr-1 hidden h-[calc(100dvh-8px)] shadow-sm md:block md:rounded-2xl md:shadow-sm"
              >
                <div className={cn('h-[calc(98vh)]', 'flex flex-col', '', className)}>
                  <div className="flex h-full flex-col">
                    <ChatHeader
                      onClose={() => {
                        setOpen(false);
                        setIsFullScreen(false);
                      }}
                      onToggleFullScreen={() => setIsFullScreen(!isFullScreen)}
                      onToggleViewMode={toggleViewMode}
                      isFullScreen={isFullScreen}
                      isPopup={isPopup}
                      onNewChat={handleNewChat}
                      view={view}
                      onToggleView={() => setView((v) => (v === 'list' ? 'chat' : 'list'))}
                    />
                    <div className="relative flex-1 overflow-hidden">
                      {view === 'list' ? listPane : chatPane}
                    </div>
                  </div>
                </div>
              </ResizablePanel>
            </>
          )}

          {/* Popup / fullscreen */}
          <div
            tabIndex={0}
            className={cn(
              'fixed inset-0 z-50 flex items-center justify-center bg-transparent p-4 backdrop-blur-sm transition-opacity duration-150 sm:inset-auto sm:bottom-4 sm:right-4 sm:flex-col sm:items-end sm:justify-end sm:p-0 lg:opacity-40 lg:hover:opacity-100',
              'md:hidden',
              isPopup && !isFullScreen && 'md:flex',
              isFullScreen && 'inset-0! flex! p-0! opacity-100! backdrop-blur-none!',
              'rounded-2xl focus:opacity-100',
            )}
          >
            <div
              className={cn(
                'bg-panelLight dark:bg-panelDark w-full overflow-hidden rounded-2xl border border-[#E7E7E7] shadow-lg dark:border-[#252525]',
                'md:hidden',
                isPopup && !isFullScreen && 'w-[600px] max-w-[90vw] sm:w-[400px] md:block',
                isFullScreen && 'block! max-w-none! rounded-none! border-none!',
              )}
            >
              <div
                className={cn(
                  'flex w-full flex-col',
                  isFullScreen ? 'h-screen' : 'h-[90vh] sm:h-[600px] sm:max-h-[85vh]',
                )}
              >
                <ChatHeader
                  onClose={() => {
                    setOpen(false);
                    setIsFullScreen(false);
                  }}
                  onToggleFullScreen={() => setIsFullScreen(!isFullScreen)}
                  onToggleViewMode={toggleViewMode}
                  isFullScreen={isFullScreen}
                  isPopup={isPopup}
                  onNewChat={handleNewChat}
                />
                <div className="relative flex-1 overflow-hidden">
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
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}

export default AISidebar;
