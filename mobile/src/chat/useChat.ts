import { useEffect, useState, useSyncExternalStore } from 'react';
import { ChatStore } from './ChatStore';
import { useDeviceIdentity } from './DeviceIdentity';

export function useChat(conversationId: string) {
  const deviceId = useDeviceIdentity();
  const [chatStore] = useState(() => new ChatStore(conversationId, deviceId));
  useEffect(() => {
    chatStore.start();
    return () => chatStore.stop();
  }, [chatStore]);
  const state = useSyncExternalStore(chatStore.subscribe, chatStore.getState);
  return { chatStore, ...state };
}
