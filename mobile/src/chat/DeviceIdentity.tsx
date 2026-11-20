import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { ActivityIndicator, Button, Platform, Text, View } from 'react-native';
import { colors } from '../theme';

const STORAGE_KEY = 'drkudos.deviceId.v1';
const IdentityContext = createContext<string | null>(null);
let identityPromise: Promise<string> | undefined;

function loadIdentity(): Promise<string> {
  // Each browser page represents a separate demo device. Native installs keep
  // their identity across process restarts and app updates.
  identityPromise ??= (async () => {
    if (Platform.OS === 'web') return Crypto.randomUUID();
    const stored = await AsyncStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
    const created = Crypto.randomUUID();
    await AsyncStorage.setItem(STORAGE_KEY, created);
    return created;
  })().catch((error) => {
    identityPromise = undefined;
    throw error;
  });
  return identityPromise;
}

export function DeviceIdentityProvider({ children }: { children: ReactNode }) {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    loadIdentity().then(
      (id) => { if (active) setDeviceId(id); },
      () => { if (active) setFailed(true); },
    );
    return () => { active = false; };
  }, [attempt]);

  if (!deviceId) {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24, backgroundColor: colors.bg }}>
        {failed ? <>
          <Text>Could not load this device’s identity. Please retry.</Text>
          <Button title="Retry" onPress={() => { setFailed(false); setAttempt((value) => value + 1); }} />
        </> : <ActivityIndicator color={colors.ink} />}
      </View>
    );
  }
  return <IdentityContext.Provider value={deviceId}>{children}</IdentityContext.Provider>;
}

export function useDeviceIdentity() {
  const deviceId = useContext(IdentityContext);
  if (!deviceId) throw new Error('Chat must wait for device identity');
  return deviceId;
}
