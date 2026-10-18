import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import type { LocalChatMessage } from '@/contracts/evidence';

export const MessageBubble = memo(function MessageBubble({ item }: { item: LocalChatMessage }) {
  const mine = item.role === 'user';
  return (
    <View style={[styles.row, mine ? styles.rowMine : styles.rowAgent]}>
      {!mine && (
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>A</Text>
        </View>
      )}
      <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleAgent]}>
        <Text style={[styles.bubbleText, mine && styles.bubbleTextMine]}>{item.text}</Text>
      </View>
    </View>
  );
});

export function TypingRow() {
  return (
    <View style={[styles.row, styles.rowAgent]}>
      <View style={styles.avatar}>
        <Text style={styles.avatarText}>A</Text>
      </View>
      <View style={[styles.bubble, styles.bubbleAgent]}>
        <Text style={styles.typing}>•••</Text>
      </View>
    </View>
  );
}

export function ChatComposer({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (text: string) => Promise<void>;
}) {
  const [value, setValue] = useState('');

  const submit = async () => {
    const text = value.trim();
    if (!text || disabled) return;
    setValue('');
    await onSend(text);
  };

  return (
    <View style={styles.composerWrap}>
      <TextInput
        accessibilityLabel="Wiadomość do osobistego agenta"
        style={styles.input}
        value={value}
        onChangeText={setValue}
        placeholder="Napisz do swojego agenta"
        placeholderTextColor="#8a8a98"
        multiline
        maxLength={2000}
        editable={!disabled}
        returnKeyType="send"
        onSubmitEditing={() => void submit()}
      />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Wyślij wiadomość"
        disabled={disabled || value.trim().length === 0}
        onPress={() => void submit()}
        style={({ pressed }) => [
          styles.sendButton,
          (disabled || value.trim().length === 0) && styles.sendButtonDisabled,
          pressed && styles.pressed,
        ]}
      >
        <Text style={styles.sendText}>↑</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', marginHorizontal: 12, marginVertical: 4, alignItems: 'flex-end' },
  rowMine: { justifyContent: 'flex-end' },
  rowAgent: { justifyContent: 'flex-start' },
  avatar: {
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: '#5B4DBC',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 7,
  },
  avatarText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  bubble: { maxWidth: '78%', borderRadius: 20, paddingHorizontal: 13, paddingVertical: 9 },
  bubbleMine: { backgroundColor: '#5B4DBC', borderBottomRightRadius: 5 },
  bubbleAgent: { backgroundColor: '#ECECF1', borderBottomLeftRadius: 5 },
  bubbleText: { color: '#191922', fontSize: 16, lineHeight: 22 },
  bubbleTextMine: { color: '#fff' },
  typing: { color: '#696978', fontSize: 18, letterSpacing: 2 },
  composerWrap: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: '#D9D9E2',
    backgroundColor: '#fff',
  },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    borderRadius: 21,
    backgroundColor: '#F1F1F6',
    paddingHorizontal: 14,
    paddingVertical: 10,
    fontSize: 16,
    color: '#191922',
  },
  sendButton: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#5B4DBC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendButtonDisabled: { opacity: 0.35 },
  pressed: { opacity: 0.75 },
  sendText: { color: '#fff', fontSize: 22, fontWeight: '700', marginTop: -2 },
});
