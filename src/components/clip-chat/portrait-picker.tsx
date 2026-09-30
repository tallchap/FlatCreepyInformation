"use client";
import { useEffect, useRef } from "react";
import { Scissors } from "lucide-react";
import { FEATURED_SPEAKERS } from "./speakers";
import styles from "./clip-chat.module.css";

export function PortraitPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: string;
  onChange: (slug: string, name: string) => void;
  disabled?: boolean;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const latest = useRef({ value, onChange, disabled });
  latest.current = { value, onChange, disabled };
  const repaint = useRef<() => void>(() => {});
  useEffect(() => {
    const stage = stageRef.current!;
    const cards = Array.from(
      stage.querySelectorAll<HTMLButtonElement>("[data-portrait]"),
    );
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const count = FEATURED_SPEAKERS.length;
    const wrap = (n: number) => (n + count) % count;
    const current = () =>
      Math.max(
        0,
        FEATURED_SPEAKERS.findIndex((p) => p.slug === latest.current.value),
      );
    const step = () => (stage.clientWidth < 340 ? 94 : 112);
    let suppressClickUntil = 0;
    let drag: {
      id: number;
      x: number;
      y: number;
      dx: number;
      axis: "x" | "y" | null;
      lastX: number;
      lastTime: number;
      velocity: number;
    } | null = null;
    function paint(dx = 0, animate = true) {
      cards.forEach((card, index) => {
        let relative = wrap(index - current());
        if (relative > 3) relative -= count;
        const distance = relative + dx / step(),
          abs = Math.abs(distance);
        card.style.transition =
          animate && !motion.matches
            ? "transform 480ms cubic-bezier(.22,1.22,.36,1), opacity 280ms ease"
            : "none";
        card.style.transform = `translateX(${distance * step()}px) translateY(${Math.min(abs, 2) * 10}px) rotate(${distance * 11 - 5}deg) scale(${Math.max(0.52, 1 - abs * 0.3)})`;
        card.style.opacity = String(
          abs > 1.9 ? 0 : Math.max(0, 1 - abs * 0.72),
        );
        card.style.zIndex = String(10 - Math.round(abs * 2));
        card.style.pointerEvents = abs < 1.4 ? "auto" : "none";
        card.setAttribute("aria-hidden", String(abs >= 1.4));
        card.querySelector<HTMLElement>("[data-badge]")!.style.opacity = String(
          Math.max(0, 1 - abs * 2),
        );
      });
    }
    function choose(index: number) {
      if (latest.current.disabled) return;
      const person = FEATURED_SPEAKERS[wrap(index)];
      latest.current.onChange(person.slug, person.name);
    }
    function finish(event: PointerEvent, cancelled = false) {
      if (!drag || drag.id !== event.pointerId) return;
      const gesture = drag;
      drag = null;
      stage.classList.remove(styles.dragging);
      if (stage.hasPointerCapture(event.pointerId))
        stage.releasePointerCapture(event.pointerId);
      if (gesture.axis !== "x") return;
      suppressClickUntil = performance.now() + 350;
      const flick =
        event.timeStamp - gesture.lastTime < 100 &&
        Math.abs(gesture.velocity) > 0.45 &&
        Math.abs(gesture.dx) > 12;
      if (!cancelled && (Math.abs(gesture.dx) > step() * 0.32 || flick))
        choose(current() + (gesture.dx < 0 ? 1 : -1));
      else paint();
    }
    stage.onpointerdown = (event) => {
      if (
        latest.current.disabled ||
        !event.isPrimary ||
        event.button !== 0 ||
        drag
      )
        return;
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        dx: 0,
        axis: null,
        lastX: event.clientX,
        lastTime: event.timeStamp,
        velocity: 0,
      };
    };
    stage.onpointermove = (event) => {
      if (!drag || drag.id !== event.pointerId) return;
      const dx = event.clientX - drag.x,
        dy = event.clientY - drag.y;
      if (!drag.axis && Math.max(Math.abs(dx), Math.abs(dy)) > 7) {
        drag.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
        if (drag.axis === "x") {
          stage.setPointerCapture(event.pointerId);
          stage.classList.add(styles.dragging);
        }
      }
      if (drag.axis !== "x") return;
      const elapsed = event.timeStamp - drag.lastTime;
      if (elapsed > 0) drag.velocity = (event.clientX - drag.lastX) / elapsed;
      drag.lastX = event.clientX;
      drag.lastTime = event.timeStamp;
      drag.dx = dx;
      paint(Math.max(-step() * 1.12, Math.min(step() * 1.12, dx)), false);
    };
    stage.onpointerup = (event) => finish(event);
    stage.onpointercancel = (event) => finish(event, true);
    stage.onlostpointercapture = (event) => {
      // Ignore the card's bubbled release when touch capture transfers to the stage.
      if (event.target === stage) finish(event, true);
    };
    stage.onpointerleave = (event) => {
      if (drag && !stage.hasPointerCapture(event.pointerId))
        finish(event, true);
    };
    stage.ondragstart = (event) => event.preventDefault();
    stage.onclick = (event) => {
      if (performance.now() < suppressClickUntil) return;
      const card = (event.target as HTMLElement).closest<HTMLButtonElement>(
        "[data-portrait]",
      );
      if (card) choose(Number(card.dataset.portrait));
    };
    stage.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
        return;
      event.preventDefault();
      choose(
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? count - 1
            : current() + (event.key === "ArrowRight" ? 1 : -1),
      );
    };
    const observer = new ResizeObserver(() => {
      if (!drag) paint(0, false);
    });
    observer.observe(stage);
    repaint.current = () => paint();
    paint(0, false);
    return () => {
      observer.disconnect();
      stage.onpointerdown =
        stage.onpointermove =
        stage.onpointerup =
        stage.onpointercancel =
        stage.onlostpointercapture =
        stage.onpointerleave =
          null;
      stage.ondragstart = stage.onclick = stage.onkeydown = null;
    };
  }, []);
  useEffect(() => repaint.current(), [value]);
  return (
    <div
      ref={stageRef}
      className={styles.portraitStage}
      tabIndex={disabled ? -1 : 0}
      role="group"
      aria-roledescription="carousel"
      aria-label="Choose a speaker"
      aria-disabled={disabled}
    >
      {FEATURED_SPEAKERS.map((person, index) => (
        <button
          key={person.slug}
          data-portrait={index}
          className={styles.portraitCard}
          tabIndex={-1}
          disabled={disabled}
          aria-label={`Select ${person.name}`}
          aria-pressed={value === person.slug}
          style={{ backgroundColor: person.color }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={`/speakers/${person.slug}.jpg`}
            alt={person.name}
            draggable={false}
          />
          <span data-badge className={styles.badge}>
            <Scissors size={20} />
          </span>
        </button>
      ))}
    </div>
  );
}
