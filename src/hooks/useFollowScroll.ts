import { type UIEvent, useEffect, useRef } from 'react';

const AT_END_THRESHOLD = 24;

/**
 * Pins a scroll container to the newest content, unless the user has scrolled
 * up to read back. Resets to following whenever `resetKey` changes, so opening
 * a different conversation starts at the bottom again.
 */
export function useFollowScroll(resetKey: string | null, messages: unknown[]) {
  const container = useRef<HTMLElement>(null);
  const shouldFollow = useRef(true);
  const previousKey = useRef<string | null>(null);

  useEffect(() => {
    if (resetKey !== previousKey.current) {
      previousKey.current = resetKey;
      shouldFollow.current = true;
    }

    const element = container.current;
    if (messages.length > 0 && element && shouldFollow.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [resetKey, messages]);

  function onScroll(event: UIEvent<HTMLElement>) {
    const element = event.currentTarget;
    const distanceFromEnd =
      element.scrollHeight - element.scrollTop - element.clientHeight;
    shouldFollow.current = distanceFromEnd <= AT_END_THRESHOLD;
  }

  return { ref: container, onScroll };
}
