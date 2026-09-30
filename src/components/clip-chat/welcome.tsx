"use client";
import { PortraitPicker } from "./portrait-picker";
import { SEARCH_SPEAKERS } from "./speakers";
import styles from "./clip-chat.module.css";
export function Welcome({
  speaker,
  name,
  onSpeakerChange,
  disabled = false,
}: {
  speaker: string;
  name: string;
  onSpeakerChange: (slug: string, name: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className={styles.welcome}>
      {SEARCH_SPEAKERS.some((person) => person.slug === speaker) && (
        <PortraitPicker
          value={speaker}
          onChange={onSpeakerChange}
          disabled={disabled}
        />
      )}
      <h1>
        {speaker === "all" ? (
          <>
            Find a clip from <span>any speaker</span>
          </>
        ) : (
          <>
            Find {/^[aeiou]/i.test(name) ? "an" : "a"} <span>{name}</span> clip
          </>
        )}
        <em>!</em>
      </h1>
    </div>
  );
}
