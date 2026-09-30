"use client";
import { PortraitPicker } from "./portrait-picker";
import { FEATURED_SPEAKERS, SUGGESTIONS } from "./speakers";
import styles from "./clip-chat.module.css";
export function Welcome({
  speaker,
  name,
  onSpeakerChange,
  onSuggestion,
  disabled = false,
}: {
  speaker: string;
  name: string;
  onSpeakerChange: (slug: string, name: string) => void;
  onSuggestion: (text: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.welcome}>
      {FEATURED_SPEAKERS.some((person) => person.slug === speaker) && (
        <PortraitPicker
          value={speaker}
          onChange={onSpeakerChange}
          disabled={disabled}
        />
      )}
      <h1>
        Find{" "}
        {speaker === "all" ? (
          "a clip"
        ) : (
          <>
            a <span>{name}</span> clip
          </>
        )}
        <em>!</em>
      </h1>
      <div className={styles.suggestions}>
        {SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion.topic}
            disabled={disabled}
            onClick={() =>
              onSuggestion(
                `Find a clip of ${speaker === "all" ? "someone" : name} talking about ${suggestion.topic}`,
              )
            }
          >
            <span aria-hidden="true">{suggestion.icon}</span> {suggestion.label}
          </button>
        ))}
      </div>
    </div>
  );
}
