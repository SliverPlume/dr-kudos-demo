import { useCallback, useEffect, useLayoutEffect, useRef, type ComponentRef } from 'react';
import { AppState, Platform, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import type { ChatMessage } from '../api/types';
import type { ChatStore } from './ChatStore';

// Measure the message itself, excluding date headers and virtualized spacers.
export function useReadReceipts(store: ChatStore, messages: ChatMessage[], ready: React.RefObject<boolean>) {
  const viewportRef = useRef<ComponentRef<typeof View>>(null);
  const messageRefs = useRef(new Map<string, ComponentRef<typeof View>>());
  const messagesRef = useRef(messages);
  useLayoutEffect(() => { messagesRef.current = messages; }, [messages]);
  const focused = useRef(false);
  const androidFocused = useRef(true);
  const frame = useRef<number | null>(null);
  const revision = useRef(0);

  const invalidate = useCallback(() => { revision.current++; }, []);
  const setMessageRef = useCallback((id: string, node: ComponentRef<typeof View> | null) => {
    if (node) messageRefs.current.set(id, node); else messageRefs.current.delete(id);
  }, []);
  const active = useCallback(() => focused.current && ready.current && (
    Platform.OS === 'web'
      ? document.visibilityState === 'visible' && document.hasFocus()
      : AppState.currentState === 'active' && androidFocused.current
  ), [ready]);

  const checkVisibleMessages = useCallback(() => {
    const currentRevision = ++revision.current;
    if (frame.current != null) cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      if (!active()) return;
      viewportRef.current?.measureInWindow((left, top, width, height) => {
        if (height <= 0 || width <= 0 || !active() || revision.current !== currentRevision) return;
        const candidates = messagesRef.current.filter((message) =>
          !message.readAt && message.seq != null && (message.sender === 'AI' || message.sender === 'STAFF') && messageRefs.current.has(message.id));
        const measurements = candidates.map((message) => new Promise<string | null>((resolve) => {
          messageRefs.current.get(message.id)!.measureInWindow((x, y, messageWidth, messageHeight) => {
            const visibleHeight = Math.max(0, Math.min(y + messageHeight, top + height) - Math.max(y, top));
            const enoughHeight = messageHeight <= height
              ? visibleHeight >= messageHeight - 1
              : visibleHeight >= height / 2;
            resolve(messageHeight > 0 && messageWidth > 0 && x >= left - 1 && x + messageWidth <= left + width + 1 && enoughHeight ? message.id : null);
          });
        }));
        void Promise.all(measurements).then((ids) => {
          // Measurements are asynchronous: discard results after a gesture,
          // room change, layout change or transition to the background.
          if (revision.current === currentRevision && active()) {
            void store.markVisibleMessagesRead(ids.filter((id): id is string => id != null));
          }
        });
      });
    });
  }, [active, store]);

  useFocusEffect(useCallback(() => {
    focused.current = true;
    checkVisibleMessages();
    return () => { focused.current = false; revision.current++; };
  }, [checkVisibleMessages]));

  useEffect(() => {
    const changes = [AppState.addEventListener('change', checkVisibleMessages)];
    if (Platform.OS === 'android') {
      changes.push(AppState.addEventListener('blur', () => { androidFocused.current = false; revision.current++; }));
      changes.push(AppState.addEventListener('focus', () => { androidFocused.current = true; checkVisibleMessages(); }));
    }
    if (Platform.OS === 'web') {
      document.addEventListener('visibilitychange', checkVisibleMessages);
      window.addEventListener('focus', checkVisibleMessages);
      window.addEventListener('blur', checkVisibleMessages);
    }
    return () => {
      changes.forEach((subscription) => subscription.remove());
      invalidate();
      if (frame.current != null) cancelAnimationFrame(frame.current);
      if (Platform.OS === 'web') {
        document.removeEventListener('visibilitychange', checkVisibleMessages);
        window.removeEventListener('focus', checkVisibleMessages);
        window.removeEventListener('blur', checkVisibleMessages);
      }
    };
  }, [checkVisibleMessages, invalidate]);

  return { viewportRef, setMessageRef, checkVisibleMessages };
}
