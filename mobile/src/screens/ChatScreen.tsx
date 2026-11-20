import { useCallback, useEffect, useRef, useState, type ComponentRef } from 'react';
import {
  ActivityIndicator,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useReadReceipts } from '../chat/useReadReceipts';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { ChatMessage } from '../api/types';
import { ChatHeader } from '../components/ChatHeader';
import { Composer } from '../components/Composer';
import { MessageBubble } from '../components/MessageBubble';
import { TypingBubble } from '../components/TypingBubble';
import { useChat } from '../chat/useChat';
import { colors, font, radius } from '../theme';

const dayKey = (iso: string) => new Date(iso).toDateString();
function dayLabel(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return 'Today';
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date.toLocaleDateString([], {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === today.getFullYear() ? undefined : 'numeric',
  });
}

export function ChatScreen({ conversationId }: { conversationId: string }) {
  const { chatStore, messages, conversation, connection, initialLoading, loadingOlder, hasMore, error } = useChat(conversationId);
  const listRef = useRef<FlatList<ChatMessage>>(null);
  const followLatest = useRef(true);
  const userScrolling = useRef(false);
  const userGesture = useRef(false);
  const contentHeight = useRef(0);
  const viewportHeight = useRef(0);
  const scrollOffset = useRef(0);
  const scrollFrame = useRef<number | null>(null);
  const gestureFrame = useRef<number | null>(null);
  const historyFrame = useRef<number | null>(null);
  const messageNodes = useRef(new Map<string, ComponentRef<typeof View>>());
  const historyRevision = useRef(0);
  const historyAnchor = useRef<{ id: string; top: number } | null>(null);
  const lastBottomTarget = useRef<number | null>(null);
  const [preservePosition, setPreservePosition] = useState(false);
  const didInitialScroll = useRef(false);
  const positioned = useRef(false);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const [buttonFocused, setButtonFocused] = useState(false);
  const { viewportRef, setMessageRef, checkVisibleMessages } = useReadReceipts(chatStore, messages, positioned);
  const updateScrollButton = useCallback(() => {
    setShowScrollButton(positioned.current && !followLatest.current &&
      contentHeight.current > viewportHeight.current &&
      contentHeight.current - viewportHeight.current - scrollOffset.current > 80);
  }, []);
  useEffect(() => { checkVisibleMessages(); }, [messages, connection, checkVisibleMessages]);
  const retry = useCallback((key: string) => chatStore.retry(key), [chatStore]);

  const cancelScroll = useCallback(() => {
    if (scrollFrame.current != null) cancelAnimationFrame(scrollFrame.current);
    scrollFrame.current = null;
    lastBottomTarget.current = null;
  }, []);

  const clearHistoryAnchor = useCallback(() => {
    historyRevision.current++;
    historyAnchor.current = null;
    if (historyFrame.current != null) cancelAnimationFrame(historyFrame.current);
    historyFrame.current = null;
  }, []);

  const restoreHistoryPosition = useCallback(() => {
    if (!historyAnchor.current) return;
    if (historyFrame.current != null) cancelAnimationFrame(historyFrame.current);
    historyFrame.current = requestAnimationFrame(() => {
      historyFrame.current = null;
      const anchor = historyAnchor.current;
      if (!anchor || followLatest.current) return;
      if (Platform.OS === 'web') {
        const node = listRef.current?.getScrollableNode() as HTMLElement | null;
        const message = document.getElementById(anchor.id);
        if (!node || !message || !node.contains(message)) return;
        const delta = message.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.top;
        if (Math.abs(delta) > 1) listRef.current?.scrollToOffset({ offset: node.scrollTop + delta, animated: false });
      } else {
        // Native MVCP may lose its anchor when virtualized cells are recycled.
        // Correct only the remaining displacement after native layout finishes.
        viewportRef.current?.measureInWindow((x, top) => {
          messageNodes.current.get(anchor.id)?.measureInWindow((messageX, messageTop, width, height) => {
            if (historyAnchor.current !== anchor || followLatest.current || height <= 0) return;
            const delta = messageTop - top - anchor.top;
            if (Math.abs(delta) > 1) listRef.current?.scrollToOffset({ offset: Math.max(0, scrollOffset.current + delta), animated: false });
          });
        });
      }
    });
  }, [viewportRef]);

  const registerMessage = useCallback((message: ChatMessage, node: ComponentRef<typeof View> | null) => {
    setMessageRef(message.id, node);
    const id = `chat-message-${message.key}`;
    if (node) messageNodes.current.set(id, node); else messageNodes.current.delete(id);
  }, [setMessageRef]);

  const loadOlder = useCallback(() => {
    if (loadingOlder || !hasMore) return;
    cancelScroll();
    followLatest.current = false;
    setPreservePosition(true);
    if (Platform.OS === 'web') {
      // React Native Web has no native maintainVisibleContentPosition support.
      // Keep the visible message anchored while virtualized rows are measured.
      const node = listRef.current?.getScrollableNode() as HTMLElement | null;
      if (node) {
        const top = node.getBoundingClientRect().top;
        const message = Array.from(node.querySelectorAll('[id^="chat-message-"]'))
          .find((element) => element.getBoundingClientRect().bottom > top);
        historyAnchor.current = message ? { id: message.id, top: message.getBoundingClientRect().top - top } : null;
      }
    }
    if (Platform.OS === 'web') {
      void chatStore.loadOlder();
    } else {
      const revision = ++historyRevision.current;
      viewportRef.current?.measureInWindow((x, top, width, height) => {
        const measurements = [...messageNodes.current].map(([id, node]) => new Promise<{ id: string; top: number } | null>((resolve) => {
          node.measureInWindow((messageX, messageTop, messageWidth, messageHeight) => {
            resolve(messageHeight > 0 && messageTop + messageHeight > top && messageTop < top + height
              ? { id, top: messageTop - top } : null);
          });
        }));
        void Promise.all(measurements).then((positions) => {
          if (revision !== historyRevision.current) return;
          historyAnchor.current = positions.filter((position) => position != null).sort((a, b) => a.top - b.top)[0] ?? null;
          void chatStore.loadOlder();
        });
      });
    }
  }, [chatStore, loadingOlder, hasMore, cancelScroll, viewportRef]);

  const scrollToBottom = useCallback((animated = false) => {
    if (!followLatest.current || userScrolling.current) return;
    // Layout and content events share a frame and use the latest dimensions.
    if (scrollFrame.current != null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      if (!followLatest.current || userScrolling.current || viewportHeight.current <= 0 || contentHeight.current <= 0) return;
      const offset = Math.max(0, contentHeight.current - viewportHeight.current);
      userGesture.current = false;
      if (Math.abs(offset - scrollOffset.current) > 1 && offset !== lastBottomTarget.current) {
        listRef.current?.scrollToOffset({ offset, animated });
      }
      if (Math.abs(offset - scrollOffset.current) <= 1) positioned.current = true;
      lastBottomTarget.current = offset;
      didInitialScroll.current = true;
      updateScrollButton();
      checkVisibleMessages();
    });
  }, [updateScrollButton, checkVisibleMessages]);

  const beginUserScroll = useCallback(() => {
    cancelScroll();
    clearHistoryAnchor();
    if (Platform.OS === 'web') {
      const node = listRef.current?.getScrollableNode() as HTMLElement | null;
      node?.scrollTo({ top: node.scrollTop, behavior: 'instant' });
    }
    if (gestureFrame.current != null) cancelAnimationFrame(gestureFrame.current);
    gestureFrame.current = null;
    userGesture.current = true;
    userScrolling.current = true;
    followLatest.current = false;
    setPreservePosition(true);
  }, [cancelScroll, clearHistoryAnchor]);

  const finishUserScroll = useCallback(() => {
    userScrolling.current = false;
    followLatest.current = contentHeight.current - viewportHeight.current - scrollOffset.current <= 80;
    if (followLatest.current) {
      setPreservePosition(false);
      scrollToBottom();
    }
  }, [scrollToBottom]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffset.current = event.nativeEvent.contentOffset.y;
    if (didInitialScroll.current && contentHeight.current - viewportHeight.current - scrollOffset.current <= 1) positioned.current = true;
    updateScrollButton();
    checkVisibleMessages();
  }, [updateScrollButton, checkVisibleMessages]);

  const onScrollEndDrag = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    scrollOffset.current = event.nativeEvent.contentOffset.y;
    // Momentum may begin immediately after the drag ends and cancel this.
    gestureFrame.current = requestAnimationFrame(() => {
      gestureFrame.current = null;
      finishUserScroll();
    });
  }, [finishUserScroll]);

  const onContentSizeChange = useCallback((width: number, height: number) => {
    contentHeight.current = height;
    updateScrollButton();
    checkVisibleMessages();
    restoreHistoryPosition();
    scrollToBottom();
  }, [scrollToBottom, restoreHistoryPosition, updateScrollButton, checkVisibleMessages]);

  useEffect(() => () => {
    cancelScroll();
    clearHistoryAnchor();
    if (gestureFrame.current != null) cancelAnimationFrame(gestureFrame.current);
  }, [cancelScroll, clearHistoryAnchor]);

  useEffect(() => {
    if (Platform.OS !== 'web') return;
    const node = listRef.current?.getScrollableNode() as HTMLElement | null;
    if (!node) return;
    let pointerDown = false;
    let idleFrame: number | null = null;
    const finish = () => {
      if (pointerDown || !userScrolling.current) return;
      if (idleFrame != null) cancelAnimationFrame(idleFrame);
      idleFrame = null;
      scrollOffset.current = node.scrollTop;
      finishUserScroll();
    };
    // Web does not emit native drag/momentum callbacks. Detect actual input,
    // and also settle wheel/touch gestures that stop at a scroll boundary.
    const watchPosition = () => {
      if (idleFrame != null) cancelAnimationFrame(idleFrame);
      const previousOffset = node.scrollTop;
      idleFrame = requestAnimationFrame(() => {
        idleFrame = requestAnimationFrame(() => {
          idleFrame = null;
          if (pointerDown || node.scrollTop !== previousOffset) watchPosition();
          else finish();
        });
      });
    };
    const begin = () => { beginUserScroll(); watchPosition(); };
    const press = () => { pointerDown = true; begin(); };
    const release = () => { pointerDown = false; };
    const key = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) begin();
    };
    node.addEventListener('wheel', begin, { passive: true });
    node.addEventListener('pointerdown', press, { passive: true });
    node.addEventListener('keydown', key);
    node.addEventListener('scrollend', finish);
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
    return () => {
      if (idleFrame != null) cancelAnimationFrame(idleFrame);
      node.removeEventListener('wheel', begin);
      node.removeEventListener('pointerdown', press);
      node.removeEventListener('keydown', key);
      node.removeEventListener('scrollend', finish);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
    };
  }, [initialLoading, beginUserScroll, finishUserScroll]);

  const resumeFollowing = useCallback(() => {
    cancelScroll();
    clearHistoryAnchor();
    if (gestureFrame.current != null) cancelAnimationFrame(gestureFrame.current);
    gestureFrame.current = null;
    userScrolling.current = false;
    userGesture.current = false;
    setPreservePosition(false);
    followLatest.current = true;
    setShowScrollButton(false);
  }, [cancelScroll, clearHistoryAnchor]);

  const returnToLatest = useCallback(() => {
    resumeFollowing();
    scrollToBottom(true);
  }, [resumeFollowing, scrollToBottom]);

  const send = useCallback((text: string) => {
    resumeFollowing();
    chatStore.send(text);
  }, [chatStore, resumeFollowing]);

  const renderItem = useCallback(
    ({ item, index }: { item: ChatMessage; index: number }) => {
      const previousMessage = messages[index - 1];
      const startsNewDay = !previousMessage || dayKey(previousMessage.createdAt) !== dayKey(item.createdAt);
      const showName = startsNewDay || !previousMessage || previousMessage.sender !== item.sender;
      return (
        <>
          {startsNewDay && (
            <View style={styles.dayRow}>
              <Text style={styles.dayText}>{dayLabel(item.createdAt)}</Text>
            </View>
          )}
          <View
            collapsable={false}
            ref={(node) => registerMessage(item, node)}
            onLayout={() => { restoreHistoryPosition(); checkVisibleMessages(); }}
            nativeID={Platform.OS === 'web' ? `chat-message-${item.key}` : undefined}>
            <MessageBubble message={item} showName={showName} onRetry={retry} />
          </View>
        </>
      );
    },
    [messages, retry, registerMessage, restoreHistoryPosition, checkVisibleMessages],
  );

  const banner =
    error ?? (connection === 'reconnecting' ? 'Connection lost — reconnecting…' : null);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'right', 'bottom', 'left']}>
      <ChatHeader conversation={conversation} connection={connection} deviceId={chatStore.deviceId} />
      {banner && (
        <View style={styles.banner}>
          <Text style={styles.bannerText}>{banner}</Text>
        </View>
      )}
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        {initialLoading && messages.length === 0 ? (
          <View style={styles.center}>
            <ActivityIndicator color={colors.ink} />
          </View>
        ) : (
          <View ref={viewportRef} collapsable={false} style={styles.messageArea}>
          <FlatList
            ref={listRef}
            style={styles.flex}
            data={messages}
            keyExtractor={(message) => message.key}
            renderItem={renderItem}
            onScroll={onScroll}
            onScrollBeginDrag={beginUserScroll}
            onScrollEndDrag={onScrollEndDrag}
            onMomentumScrollBegin={() => {
              if (userGesture.current) beginUserScroll();
            }}
            onMomentumScrollEnd={(event) => {
              if (!userScrolling.current) return;
              scrollOffset.current = event.nativeEvent.contentOffset.y;
              finishUserScroll();
            }}
            onLayout={(event) => {
              viewportHeight.current = event.nativeEvent.layout.height;
              updateScrollButton();
              checkVisibleMessages();
              restoreHistoryPosition();
              scrollToBottom();
            }}
            scrollEventThrottle={32}
            onContentSizeChange={onContentSizeChange}
            // Prepending older messages must not make the visible ones jump.
            maintainVisibleContentPosition={preservePosition ? { minIndexForVisible: 0 } : undefined}
            refreshControl={
              <RefreshControl
                refreshing={loadingOlder}
                onRefresh={loadOlder}
                enabled={hasMore}
                tintColor={colors.ink}
                colors={[colors.ink]}
                title={hasMore ? 'Loading earlier messages' : undefined}
              />
            }
            ListHeaderComponent={
              hasMore ? (
                <Pressable accessibilityRole="button" onPress={loadOlder} disabled={loadingOlder}>
                  <Text style={styles.historyHint}>
                    {loadingOlder
                      ? 'Loading earlier messages…'
                      : Platform.OS === 'web'
                        ? 'Load earlier messages'
                        : '↓ Pull down or tap to load earlier messages'}
                  </Text>
                </Pressable>
              ) : (
                <Text style={styles.historyHint}>
                  {hasMore ? '↓ Pull down to load earlier messages' : 'Start of your conversation with Dr. Kudos'}
                </Text>
              )
            }
            ListFooterComponent={
              conversation?.aiTyping && conversation.mode === 'AI' ? <TypingBubble /> : <View style={{ height: 8 }} />
            }
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
          />
          {showScrollButton && messages.length > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Scroll to bottom"
              onPress={returnToLatest}
              onFocus={() => setButtonFocused(true)}
              onBlur={() => setButtonFocused(false)}
              style={[styles.scrollButton, buttonFocused && styles.scrollButtonFocused]}
            >
              <Ionicons name="arrow-down" size={22} color={colors.ink} />
            </Pressable>
          )}
          </View>
        )}
        {conversation && <Composer onSend={send} />}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  messageArea: { flex: 1, minHeight: 0 },
  scrollButton: {
    position: 'absolute', right: 16, bottom: 16, width: 44, height: 44,
    borderRadius: 22, backgroundColor: '#fff', borderWidth: 1, borderColor: colors.border,
    alignItems: 'center', justifyContent: 'center',
    boxShadow: '0 2px 8px rgba(0, 44, 44, 0.16)',
  },
  scrollButtonFocused: { borderWidth: 2, borderColor: colors.ink },
  safe: { flex: 1, backgroundColor: colors.surface },
  flex: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
  banner: { backgroundColor: colors.dangerTint, paddingVertical: 6, alignItems: 'center' },
  bannerText: { fontFamily: font.medium, fontSize: 12, color: colors.danger },
  historyHint: {
    textAlign: 'center',
    fontFamily: font.regular,
    fontSize: 11,
    color: colors.mutedSoft,
    paddingTop: 14,
    paddingBottom: 4,
  },
  dayRow: { alignItems: 'center', marginTop: 14, marginBottom: 6 },
  dayText: {
    fontFamily: font.medium,
    fontSize: 11,
    color: colors.muted,
    backgroundColor: colors.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: 10,
    paddingVertical: 3,
    overflow: 'hidden',
  },
});
