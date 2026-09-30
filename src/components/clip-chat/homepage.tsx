"use client";
import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Composer } from "./composer";
import { Welcome } from "./welcome";
import { CHAT_HANDOFF_KEY, SEARCH_SPEAKERS } from "./speakers";
import styles from "./clip-chat.module.css";
import type { DragFeel } from "./portrait-picker";
export function ClipHomepage({
  feel,
  elonPortrait,
  initialSpeaker = SEARCH_SPEAKERS[0].slug,
}: {
  feel?: DragFeel;
  elonPortrait?: "current" | "dark" | "stern" | "focused" | "shadow";
  initialSpeaker?: string;
}) {
  const router = useRouter();
  const [speaker, setSpeaker] = useState<string>(initialSpeaker);
  const [input, setInput] = useState("");
  const [navigating, setNavigating] = useState(false);
  const [error, setError] = useState("");
  const sending = useRef(false);
  const person = SEARCH_SPEAKERS.find((person) => person.slug === speaker)!;
  function startChat() {
    if (!input.trim() || sending.current) return;
    try {
      // Consume once on /chat: no prompt in the URL or duplicate send after refresh/back.
      sessionStorage.setItem(
        CHAT_HANDOFF_KEY,
        JSON.stringify({ speaker, prompt: input.trim() }),
      );
      sending.current = true;
      setNavigating(true);
      router.push("/chat");
    } catch {
      setError(
        "Your browser couldn’t open a new chat. Please allow site storage and try again.",
      );
    }
  }
  return (
    <section className={`${styles.surface} ${styles.homepage}`}>
      <Welcome
        feel={feel}
        elonPortrait={elonPortrait}
        speaker={speaker}
        name={person.name}
        onSpeakerChange={setSpeaker}
        disabled={navigating}
      />
      <Composer
        elonPortrait={elonPortrait}
        speaker={speaker}
        name={person.name}
        value={input}
        onChange={setInput}
        onSend={startChat}
        busy={navigating}
      />
      {error && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
    </section>
  );
}
