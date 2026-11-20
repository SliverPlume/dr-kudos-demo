import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { colors, font, radius } from '../theme';

// Keep these phrases in the offline translation dictionary.
const QUICK_REPLIES = [
  'When was my last Emface?',
  'Is there any availability this Saturday?',
  'How much is an Emface session?',
  'My face is a bit red after the treatment.',
  'I would like to talk to a real person.',
  '今個星期六有冇位',
  'Thank you!',
];

export function Composer({ onSend }: { onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  const canSend = text.trim().length > 0;

  const submit = () => {
    if (!canSend) return;
    onSend(text);
    setText('');
  };

  return (
    <View style={styles.wrap}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.chips}
        keyboardShouldPersistTaps="always"
      >
        {QUICK_REPLIES.map((reply) => (
          <Pressable
            key={reply}
            accessibilityRole="button"
            style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
            onPress={() => onSend(reply)}
          >
            <Text style={styles.chipText}>{reply}</Text>
          </Pressable>
        ))}
      </ScrollView>
      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          value={text}
          onChangeText={setText}
          placeholder="Message Dr. Kudos…"
          placeholderTextColor={colors.mutedSoft}
          multiline
          maxLength={2000}
        />
        <Pressable
          accessibilityLabel="Send"
          accessibilityRole="button"
          disabled={!canSend}
          onPress={submit}
          style={({ pressed }) => [styles.send, !canSend && styles.sendDisabled, pressed && { transform: [{ scale: 0.94 }] }]}
        >
          <Ionicons name="arrow-up" size={20} color={colors.ink} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    backgroundColor: colors.surface,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    paddingBottom: 8,
  },
  chips: { gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 2 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    borderRadius: radius.pill,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  chipPressed: { backgroundColor: colors.limeTint, borderColor: colors.limeSoft },
  chipText: { fontFamily: font.regular, fontSize: 12, color: colors.ink },
  inputRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 8, paddingHorizontal: 12, paddingTop: 8 },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    backgroundColor: colors.stone,
    borderRadius: radius.lg,
    paddingHorizontal: 16,
    paddingTop: 11,
    paddingBottom: 11,
    fontFamily: font.regular,
    fontSize: 15,
    color: colors.ink,
  },
  send: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: colors.lime,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { backgroundColor: colors.limeTint },
});
