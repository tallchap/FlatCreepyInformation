import { ChatWindow } from "@/components/chat/chat-window";

export default function ChatPage() {
  const version = process.env.BUILD_VERSION || "dev";
  const buildTime = process.env.BUILD_TIME
    ? new Date(process.env.BUILD_TIME).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    })
    : "";

  return (
    <section className="container mx-auto max-w-6xl flex flex-col gap-4">
      <h1 className="text-2xl font-bold text-gray-800">
        Chat with Speaker Transcripts
      </h1>
      <ChatWindow />
      <p className="text-[10px] text-gray-400 text-right select-all">
        v{version}{buildTime ? ` · ${buildTime}` : ""}
      </p>
    </section>
  );
}
