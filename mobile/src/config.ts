import Constants from 'expo-constants';
import { Platform } from 'react-native';

// Metro and GraphQL run on the same machine.
function serverHost(): string {
  const configuredHost = process.env.EXPO_PUBLIC_SERVER_HOST;
  if (configuredHost) return configuredHost;
  const hostUri = Constants.expoConfig?.hostUri;
  if (hostUri) return hostUri.split(':')[0];
  return Platform.OS === 'android' ? '10.0.2.2' : 'localhost';
}

const host = serverHost();
export const HTTP_URL = `http://${host}:4000/graphql`;
export const WS_URL = `ws://${host}:4000/graphql`;

export const PAGE_SIZE = 15;
