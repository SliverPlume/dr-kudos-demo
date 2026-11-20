import { useLocalSearchParams } from 'expo-router';
import { ChatScreen } from '../../screens/ChatScreen';

export default function PatientChat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChatScreen key={id} conversationId={id} />;
}
