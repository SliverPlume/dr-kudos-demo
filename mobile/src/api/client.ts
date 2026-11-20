import { createClient, type Client } from 'graphql-ws';
import { HTTP_URL, WS_URL } from '../config';

export type ConnectionState = 'connecting' | 'connected' | 'reconnecting';

export async function requestGraphQL<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(HTTP_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Server returned HTTP ${response.status}`);
    }
    const result = await response.json();
    if (result.errors?.length) {
      throw new Error(result.errors[0].message);
    }
    return result.data as T;
  } finally {
    clearTimeout(timeout);
  }
}

type ConnectionListener = (state: ConnectionState, isReconnect: boolean) => void;
const connectionListeners = new Set<ConnectionListener>();
let hasConnectedBefore = false;
let state: ConnectionState = 'connecting';
let pongTimeout: ReturnType<typeof setTimeout> | undefined;

function setState(next: ConnectionState, isReconnect = false) {
  state = next;
  connectionListeners.forEach((listener) => listener(next, isReconnect));
}

export const wsClient: Client = createClient({
  url: WS_URL,
  lazy: false,
  keepAlive: 10_000,
  retryAttempts: Infinity,
  shouldRetry: () => true,
  retryWait: async (retries) => {
    // Exponential backoff with jitter, capped at 5 s.
    const delayMs = Math.min(5000, 500 * 2 ** Math.min(retries, 10)) * (0.5 + Math.random() / 2);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  },
  on: {
    ping: (received) => {
      if (!received) pongTimeout = setTimeout(() => wsClient.terminate(), 5000);
    },
    pong: (received) => {
      if (received) clearTimeout(pongTimeout);
    },
    connected: () => {
      const isReconnect = hasConnectedBefore;
      hasConnectedBefore = true;
      setState('connected', isReconnect);
    },
    closed: () => {
      clearTimeout(pongTimeout);
      setState(hasConnectedBefore ? 'reconnecting' : 'connecting');
    },
  },
});

export function onConnectionChange(listener: ConnectionListener) {
  connectionListeners.add(listener);
  listener(state, false);
  return () => {
    connectionListeners.delete(listener);
  };
}

export function subscribe<T>(query: string, variables: Record<string, unknown>, onData: (data: T) => void) {
  return wsClient.subscribe<T>(
    { query, variables },
    {
      next: ({ data }) => data && onData(data as T),
      error: (error) => console.warn('[subscription error]', error),
      complete: () => {},
    },
  );
}
