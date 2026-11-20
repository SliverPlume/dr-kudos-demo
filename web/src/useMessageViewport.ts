import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { chatOperations, requestGraphQL, type Message } from './api';

type Item = Message & { key: string };

export function useMessageViewport(conversationId: string, items: Item[] | undefined, typing: boolean | undefined,
  connected: boolean, language: string, onRead: (messages: Message[]) => void) {
  const containerRef = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const userScrolling = useRef(false);
  const pointerDown = useRef(false);
  const positioned = useRef(false);
  const previous = useRef<{ id: string; first?: string; height: number }>({ id: '', height: 0 });
  const frame = useRef<number | null>(null);
  const gestureFrame = useRef<number | null>(null);
  const readsInFlight = useRef(new Set<string>());
  const [showScrollButton, setShowScrollButton] = useState(false);
  const current = useRef({ conversationId, items, language, onRead });
  current.current = { conversationId, items, language, onRead };

  const checkViewport = useCallback(() => {
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const container = containerRef.current;
      if (!container) return;
      const distance = container.scrollHeight - container.clientHeight - container.scrollTop;
      setShowScrollButton(positioned.current && !follow.current && distance > 80 && container.scrollHeight > container.clientHeight);
      if (!positioned.current || document.visibilityState !== 'visible' || !document.hasFocus()) return;
      const bounds = container.getBoundingClientRect();
      const { conversationId: id, items: messages, language: lang } = current.current;
      const unread = new Set(messages?.filter((message) => message.sender === 'PATIENT' && !message.readAt).map((message) => message.id));
      const ids = Array.from(container.querySelectorAll<HTMLElement>('[data-message-id]')).flatMap((node) => {
        const messageId = node.dataset.messageId!;
        if (!unread.has(messageId) || readsInFlight.current.has(messageId)) return [];
        const rect = node.getBoundingClientRect();
        const visible = Math.max(0, Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top));
        const enough = rect.height <= bounds.height ? visible >= rect.height - 1 : visible >= bounds.height / 2;
        return rect.height > 0 && rect.width > 0 && rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && enough ? [messageId] : [];
      });
      if (!ids.length) return;
      ids.forEach((id) => readsInFlight.current.add(id));
      void requestGraphQL<{ markMessagesRead: Message[] }>(chatOperations.markMessagesRead, { conversationId: id, messageIds: ids, lang })
        .then(({ markMessagesRead }) => { if (markMessagesRead.length) current.current.onRead(markMessagesRead); })
        .catch(() => { /* Recheck visibility on the next scroll, focus or reconnect. */ })
        .finally(() => ids.forEach((id) => readsInFlight.current.delete(id)));
    });
  }, []);

  const scrollToBottom = useCallback((smooth = false) => {
    const container = containerRef.current;
    if (!container || !follow.current || userScrolling.current) return;
    container.scrollTo({ top: Math.max(0, container.scrollHeight - container.clientHeight), behavior: smooth ? 'smooth' : 'instant' });
    positioned.current = true;
    checkViewport();
  }, [checkViewport]);

  const returnToLatest = useCallback(() => {
    if (gestureFrame.current != null) cancelAnimationFrame(gestureFrame.current);
    gestureFrame.current = null;
    pointerDown.current = false;
    userScrolling.current = false;
    previous.current.first = undefined;
    follow.current = true;
    setShowScrollButton(false);
    scrollToBottom(true);
  }, [scrollToBottom]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const first = items?.[0]?.key;
    const changedRoom = previous.current.id !== conversationId;
    if (changedRoom) {
      if (gestureFrame.current != null) cancelAnimationFrame(gestureFrame.current);
      gestureFrame.current = null;
      follow.current = true;
      userScrolling.current = false;
      pointerDown.current = false;
      positioned.current = false;
      setShowScrollButton(false);
    } else if (previous.current.first && first !== previous.current.first && !follow.current) {
      container.scrollTop += container.scrollHeight - previous.current.height;
    }
    if (items) scrollToBottom();
    previous.current = { id: conversationId, first, height: container.scrollHeight };
    checkViewport();
  }, [conversationId, items, typing, connected, checkViewport, scrollToBottom]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const finish = () => {
      if (pointerDown.current || !userScrolling.current) return;
      userScrolling.current = false;
      follow.current = container.scrollHeight - container.scrollTop - container.clientHeight <= 80;
      if (follow.current) scrollToBottom();
      checkViewport();
    };
    const watch = () => {
      if (gestureFrame.current != null) cancelAnimationFrame(gestureFrame.current);
      const offset = container.scrollTop;
      gestureFrame.current = requestAnimationFrame(() => {
        gestureFrame.current = requestAnimationFrame(() => {
          gestureFrame.current = null;
          if (pointerDown.current || offset !== container.scrollTop) watch(); else finish();
        });
      });
    };
    const begin = () => {
      // Stop a pending smooth scroll at its current position on new user input.
      if (follow.current) container.scrollTo({ top: container.scrollTop, behavior: 'instant' });
      follow.current = false;
      userScrolling.current = true;
      watch();
    };
    const press = () => { pointerDown.current = true; begin(); };
    const release = () => { pointerDown.current = false; };
    const key = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) begin();
    };
    const resize = new ResizeObserver(() => { scrollToBottom(); checkViewport(); });
    resize.observe(container);
    container.addEventListener('wheel', begin, { passive: true });
    container.addEventListener('pointerdown', press);
    container.addEventListener('keydown', key);
    container.addEventListener('scrollend', finish);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    window.addEventListener('focus', checkViewport);
    document.addEventListener('visibilitychange', checkViewport);
    return () => {
      resize.disconnect();
      if (frame.current != null) cancelAnimationFrame(frame.current);
      if (gestureFrame.current != null) cancelAnimationFrame(gestureFrame.current);
      container.removeEventListener('wheel', begin);
      container.removeEventListener('pointerdown', press);
      container.removeEventListener('keydown', key);
      container.removeEventListener('scrollend', finish);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('focus', checkViewport);
      document.removeEventListener('visibilitychange', checkViewport);
    };
  }, [conversationId, !!items, checkViewport, scrollToBottom]);

  return { containerRef, checkViewport, returnToLatest, showScrollButton };
}
