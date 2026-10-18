import { useRef } from 'react';
import {
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ChatComposer, MessageBubble, TypingRow } from '@/components/ChatBubbles';
import { useAgentSession } from '@/state/AgentSessionContext';

export default function ChatScreen() {
  const { messages, isGenerating, isClosingSession, sendMessage, closeSession } = useAgentSession();
  const listRef = useRef<FlatList>(null);

  return (
    <SafeAreaView style={styles.safe} edges={['top', 'bottom']}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <View style={styles.header}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>A</Text>
          </View>
          <View style={styles.headerText}>
            <Text style={styles.headerTitle}>Osobisty Agent</Text>
            <Text style={styles.headerSub}>● Na urządzeniu · rozmowy nie wychodzą do roju</Text>
          </View>
          <Pressable
            style={[styles.closeButton, isClosingSession && styles.disabled]}
            disabled={isClosingSession || isGenerating}
            onPress={() => void closeSession()}
          >
            <Text style={styles.closeText}>{isClosingSession ? 'Zamykanie…' : 'Zakończ sesję'}</Text>
          </Pressable>
        </View>

        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <MessageBubble item={item} />}
          ListFooterComponent={isGenerating ? <TypingRow /> : undefined}
          contentContainerStyle={styles.listContent}
          initialNumToRender={20}
          maxToRenderPerBatch={12}
          windowSize={7}
          removeClippedSubviews={Platform.OS !== 'web'}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: true })}
        />

        <ChatComposer disabled={isGenerating || isClosingSession} onSend={sendMessage} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#fff' },
  flex: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#D9D9E2',
  },
  avatar: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: '#5B4DBC',
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontWeight: '900', fontSize: 17 },
  headerText: { flex: 1 },
  headerTitle: { fontSize: 17, fontWeight: '800', color: '#191922' },
  headerSub: { color: '#2F7D4F', fontSize: 12, marginTop: 2 },
  closeButton: { backgroundColor: '#F0EEFF', borderRadius: 999, paddingHorizontal: 11, paddingVertical: 8 },
  closeText: { color: '#4636A8', fontWeight: '800', fontSize: 12 },
  disabled: { opacity: 0.45 },
  listContent: { paddingVertical: 12 },
});
