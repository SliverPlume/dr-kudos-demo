import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ConnectionState } from '../api/client';
import type { Conversation } from '../api/types';
import { colors, font, radius } from '../theme';

interface Props {
  conversation: Conversation | null;
  connection: ConnectionState;
  deviceId: string;
}

export function ChatHeader({ conversation, connection, deviceId }: Props) {
  const router = useRouter();
  const isStaff = conversation?.mode === 'STAFF';
  const subtitle =
    connection !== 'connected'
      ? connection === 'reconnecting'
        ? 'Reconnecting…'
        : 'Connecting…'
      : isStaff
        ? `${conversation?.staffName ?? 'Clinic staff'} is chatting with you`
        : conversation?.aiTyping
          ? 'AI is replying…'
          : 'AI-Coordinator · online';

  return (
    <View style={styles.wrap}>
      {router.canGoBack() && (
        <Pressable accessibilityRole="button" accessibilityLabel="Go back" onPress={() => router.back()} style={styles.back}>
          <Ionicons name="chevron-back" size={24} color={colors.ink} />
        </Pressable>
      )}
      <View style={[styles.avatar, isStaff && styles.avatarStaff]}>
        {isStaff ? (
          <Ionicons name="person" size={18} color={colors.ink} />
        ) : (
          <Text style={styles.avatarText}>DK</Text>
        )}
        <View
          style={[
            styles.presence,
            { backgroundColor: connection === 'connected' ? colors.green : '#e0a400' },
          ]}
        />
      </View>
      <View style={styles.titles}>
        <Text style={styles.title}>
          Dr. Kudos Clinic
        </Text>
        {conversation && <Text>{conversation.patientName}</Text>}
        <View style={styles.details}>
          <Text style={styles.subtitle}>{subtitle}</Text>
          <View style={styles.devicePill}>
            <Ionicons name="phone-portrait-outline" size={11} color={colors.muted} />
            <Text style={styles.deviceText}>{deviceId.slice(0, 4).toUpperCase()}</Text>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    backgroundColor: colors.surface,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  back: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  avatar: {
    flexShrink: 0,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarStaff: { backgroundColor: colors.lime },
  avatarText: { fontFamily: font.semibold, color: colors.lime, fontSize: 14, letterSpacing: 0.5 },
  presence: {
    position: 'absolute',
    right: -1,
    bottom: -1,
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2,
    borderColor: colors.surface,
  },
  titles: { flex: 1, minWidth: 0 },
  details: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 8, rowGap: 4 },
  title: { fontFamily: font.semibold, fontSize: 16, color: colors.ink },
  subtitle: { flexShrink: 1, fontFamily: font.regular, fontSize: 12, color: colors.muted },
  devicePill: {
    flexShrink: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    backgroundColor: colors.stone,
    borderRadius: radius.pill,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  deviceText: { fontFamily: font.medium, fontSize: 10, color: colors.muted },
});
