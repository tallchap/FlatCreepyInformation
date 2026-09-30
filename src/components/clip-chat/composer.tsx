"use client";
import { ArrowUp, LoaderCircle, UsersRound } from "lucide-react";
import { FEATURED_SPEAKERS, SUGGESTIONS, speakerPortrait } from "./speakers";
import styles from "./clip-chat.module.css";
export function Composer({
  speaker,
  name,
  value,
  onChange,
  onSend,
  busy = false,
  elonPortrait,
}: {
  speaker: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  busy?: boolean;
  elonPortrait?: "current" | "dark" | "stern" | "focused" | "shadow";
}) {
  const featured = FEATURED_SPEAKERS.find((person) => person.slug === speaker);
  return (
    <div className={styles.composerWrap}>
      <form
        className={styles.composer}
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && value.trim()) onSend();
        }}
      >
        <label className="sr-only" htmlFor="clip-prompt">
          Describe the clip you want to find
        </label>
        <textarea
          id="clip-prompt"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          maxLength={5000}
          rows={2}
          placeholder="What are you looking for?"
          disabled={busy}
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (!busy && value.trim()) onSend();
            }
          }}
        />
        <div className={styles.composerBottom}>
          <span className={styles.scope}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {featured && (
              <img src={speakerPortrait(featured.slug, elonPortrait)} alt="" />
            )}
            {speaker === "all" && <UsersRound size={23} aria-hidden="true" />}
            <span>
              Searching{" "}
              <strong>{speaker === "all" ? "all speakers" : name}</strong>
            </span>
          </span>
          <button
            type="submit"
            className={styles.send}
            disabled={busy || !value.trim()}
            aria-label={busy ? "Finding clips" : "Find a clip"}
          >
            {busy ? (
              <LoaderCircle className="animate-spin" size={21} />
            ) : (
              <ArrowUp size={23} />
            )}
          </button>
        </div>
      </form>
      <div className={styles.suggestions}>
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion.topic}
            disabled={busy}
            onClick={() => {
              onChange(
                `Find a clip of ${speaker === "all" ? "any speaker" : name} talking about ${suggestion.topic}`,
              );
              document.getElementById("clip-prompt")?.focus();
            }}
          >
            {suggestion.label}
          </button>
        ))}
      </div>
    </div>
  );
}
