"use client";
import { ArrowUp, LoaderCircle } from "lucide-react";
import { SUGGESTIONS } from "./speakers";
import styles from "./clip-chat.module.css";
export function Composer({
  speaker,
  name,
  value,
  onChange,
  onSend,
  busy = false,
  showSuggestions = true,
}: {
  speaker: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  busy?: boolean;
  showSuggestions?: boolean;
}) {
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
      {showSuggestions && (
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
      )}
    </div>
  );
}
