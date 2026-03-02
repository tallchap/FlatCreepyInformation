import { ChatWindow } from "@/components/chat/chat-window";

export default function ChatPage() {
  return (
    <section className="container mx-auto max-w-6xl flex flex-col gap-4">
      <h1 className="text-2xl font-bold text-gray-800">
        Chat with Speaker Transcripts
      </h1>
      <ChatWindow />
    </section>
  );
}
