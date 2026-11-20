import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { ChatMessage } from '../api/types';
import { colors, font, radius } from '../theme';

export const formatTime = (iso: string) =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function StatusIcon({ status, readAt }: Pick<ChatMessage, 'status' | 'readAt'>) {
  if (readAt) return <Ionicons name="checkmark-done" size={15} color={colors.lime} accessibilityLabel="Read" />;
  switch (status) {
    case 'SENDING':
      return <Ionicons name="time-outline" size={13} color="rgba(255,255,255,0.7)" accessibilityLabel="Sending" />;
    case 'SENT':
    case 'DELIVERED':
      return <Ionicons name="checkmark" size={15} color="rgba(255,255,255,0.75)" accessibilityLabel="Sent" />;
    case 'FAILED':
      return <Ionicons name="alert-circle" size={15} color="#ff9b8f" accessibilityLabel="Failed" />;
  }
}

interface Props {
  message: ChatMessage;
  showName: boolean;
  onRetry: (key: string) => void;
}

export const MessageBubble = memo(function MessageBubble({ message, showName, onRetry }: Props) {
  if (message.sender === 'SYSTEM') {
    return (
      <View style={styles.systemRow}>
        <Text style={styles.systemText}>{message.text}</Text>
      </View>
    );
  }

  const isPatient = message.sender === 'PATIENT';
  const isStaff = message.sender === 'STAFF';
  const senderLabel = isStaff ? `${message.senderName ?? 'Clinic staff'} · Clinic team` : 'Dr. Kudos AI';

  return (
    <View style={[styles.row, isPatient ? styles.rowMine : styles.rowTheirs]}>
      {!isPatient && showName && (
        <View style={styles.nameRow}>
          <Ionicons
            name={isStaff ? 'person-circle' : 'sparkles'}
            size={13}
            color={isStaff ? colors.greenDark : colors.ink}
          />
          <Text style={[styles.name, isStaff && { color: colors.greenDark }]}>{senderLabel}</Text>
        </View>
      )}
      <Pressable
        disabled={message.status !== 'FAILED'}
        onPress={() => onRetry(message.key)}
        style={[
          styles.bubble,
          isPatient ? styles.bubbleMine : isStaff ? styles.bubbleStaff : styles.bubbleAi,
          message.status === 'FAILED' && styles.bubbleFailed,
        ]}
      >
        <Text style={[styles.text, isPatient && styles.textMine]}>{message.text}</Text>
        <View style={styles.meta}>
          <Text style={[styles.time, isPatient && styles.timeMine]}>{formatTime(message.createdAt)}</Text>
          {isPatient && <StatusIcon status={message.status} readAt={message.readAt} />}
        </View>
      </Pressable>
      {message.status === 'FAILED' && <Text style={styles.failed}>Not sent · tap to retry</Text>}
    </View>
  );
});

const styles = StyleSheet.create({
  row: { paddingHorizontal: 16, marginVertical: 2, maxWidth: '100%' },
  rowMine: { alignItems: 'flex-end' },
  rowTheirs: { alignItems: 'flex-start' },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 10, marginBottom: 4, marginLeft: 4 },
  name: { fontFamily: font.medium, fontSize: 12, color: colors.ink },
  bubble: {
    maxWidth: '80%',
    paddingHorizontal: 14,
    paddingTop: 9,
    paddingBottom: 7,
    borderRadius: radius.md,
  },
  bubbleMine: { backgroundColor: colors.ink, borderBottomRightRadius: 6 },
  bubbleAi: {
    backgroundColor: colors.surface,
    borderBottomLeftRadius: 6,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  bubbleStaff: { backgroundColor: colors.limeTint, borderBottomLeftRadius: 6, borderWidth: 1, borderColor: colors.limeSoft },
  bubbleFailed: { opacity: 0.75 },
  text: { fontFamily: font.regular, fontSize: 15, lineHeight: 21, color: colors.ink },
  textMine: { color: '#fff' },
  meta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 2 },
  time: { fontFamily: font.regular, fontSize: 11, color: colors.mutedSoft },
  timeMine: { color: 'rgba(255,255,255,0.65)' },
  failed: { fontFamily: font.regular, fontSize: 11, color: colors.danger, marginTop: 3, marginRight: 4 },
  systemRow: { alignItems: 'center', marginVertical: 10, paddingHorizontal: 24 },
  systemText: {
    fontFamily: font.medium,
    fontSize: 12,
    color: colors.greenDark,
    backgroundColor: colors.limeTint,
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: radius.pill,
    overflow: 'hidden',
    textAlign: 'center',
  },
});
