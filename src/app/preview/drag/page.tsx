"use client";
import { useEffect, useState } from "react";
import { ClipHomepage } from "@/components/clip-chat/homepage";
import type { DragFeel } from "@/components/clip-chat/portrait-picker";
import styles from "./preview.module.css";
import {
  DEFAULT_ELON_PORTRAIT,
  ELON_PORTRAITS,
  type ElonPortrait,
} from "@/components/clip-chat/elon-portraits";
const OPTIONS: { id: DragFeel; title: string; description: string }[] = [
  {
    id: "glide",
    title: "A · Free glide",
    description:
      "Pull through several people. Flick to coast, then ease into place.",
  },
  {
    id: "spring",
    title: "B · Spring deck",
    description:
      "Pull straight up or sideways. More freedom, a bigger stretch, and a springy return.",
  },
  {
    id: "loose",
    title: "C · Loose cards",
    description:
      "Tug a card up or down as you swipe. More tilt and a softer landing.",
  },
];
export default function DragPreview() {
  const [photo, setPhoto] = useState<ElonPortrait>(DEFAULT_ELON_PORTRAIT);
  const [photoRevision, setPhotoRevision] = useState(0);
  useEffect(() => {
    const requested = new URLSearchParams(window.location.search).get(
      "portrait",
    );
    const match = ELON_PORTRAITS.find((p) => p.id === requested);
    if (match) setPhoto(match.id);
  }, []);
  const [feel, setFeel] = useState<DragFeel>("spring");
  return (
    <>
      <section className={styles.controls} aria-label="Compare drag options">
        <div className={styles.intro}>
          <div>
            <p>INTERACTION PREVIEW</p>
            <h1>Give the cards a proper pull.</h1>
          </div>
          <button
            aria-pressed={feel === "classic"}
            onClick={() => setFeel("classic")}
          >
            Compare current feel
          </button>
        </div>
        <div className={styles.options}>
          {OPTIONS.map((option) => (
            <button
              key={option.id}
              aria-pressed={feel === option.id}
              onClick={() => setFeel(option.id)}
            >
              <strong>
                {option.title}
                {option.id === "spring" && <small>Start here</small>}
              </strong>
              <span>{option.description}</span>
            </button>
          ))}
        </div>
        <p className={styles.hint} aria-live="polite">
          {feel === "classic"
            ? "Current feel: short travel and one speaker per swipe."
            : "Try pulling straight up in B or C, then let go. Swipe across several people, or catch a card while it’s still moving."}
        </p>
      </section>
      <div className={styles.photoChoices} aria-label="Compare Elon photos">
        <span>Elon’s photo</span>
        {ELON_PORTRAITS.map((option, index) => (
          <button
            key={option.id}
            aria-pressed={photo === option.id}
            aria-label={`Elon option ${index + 1}: ${option.label}`}
            onClick={() => {
              setPhoto(option.id);
              setPhotoRevision((value) => value + 1);
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={`/speakers/preview/elon-${option.id}.jpg`} alt="" />
            <span>{index + 1}</span>
          </button>
        ))}
        <a href="/preview/elon">Compare all 10 photos</a>
        <a
          href="/speakers/preview/credits.html"
          target="_blank"
          rel="noreferrer"
        >
          Photo sources
        </a>
      </div>
      <ClipHomepage
        key={photoRevision}
        feel={feel}
        elonPortrait={photo}
        initialSpeaker="elon-musk"
      />
    </>
  );
}
