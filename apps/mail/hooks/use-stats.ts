import { useActiveConnection } from '@/hooks/use-connections';
import { useDoState } from '@/components/mail/use-do-state';
import { useEffect } from 'react';

const storageKey = (connectionId: string) => `zero:doState:counts:${connectionId}`;

export const useStats = () => {
  const { data: activeConnection } = useActiveConnection();
  const [doState, setDoState] = useDoState();
  const connectionId = activeConnection?.id;

  // Hydrate counts from localStorage when the active connection changes, so the
  // first paint after switching accounts shows the previously-seen badges
  // immediately instead of waiting for the DO WebSocket round-trip.
  useEffect(() => {
    if (!connectionId || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(storageKey(connectionId));
      const counts = raw ? JSON.parse(raw) : [];
      setDoState((prev) => ({ ...prev, counts }));
    } catch {
      // Corrupt entry — just leave the atom as-is.
    }
  }, [connectionId, setDoState]);

  // Persist whatever counts the DO sent so the next account switch can read them.
  useEffect(() => {
    if (!connectionId || typeof window === 'undefined' || !doState.counts.length) return;
    try {
      window.localStorage.setItem(storageKey(connectionId), JSON.stringify(doState.counts));
    } catch {
      // Storage full / blocked — silently skip; we still have the in-memory atom.
    }
  }, [connectionId, doState.counts]);

  return { data: doState.counts };
};
