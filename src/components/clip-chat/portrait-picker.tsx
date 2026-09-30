"use client";
import { useEffect, useRef } from "react";
import { Scissors, UsersRound } from "lucide-react";
import { SEARCH_SPEAKERS, speakerPortrait } from "./speakers";
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
    const count = SEARCH_SPEAKERS.length;
    const wrap = (n: number) => ((n % count) + count) % count;
    const current = () =>
      Math.max(
        0,
        SEARCH_SPEAKERS.findIndex((p) => p.slug === latest.current.value),
      );
    const step = () => (stage.clientWidth < 400 ? 120 : 154);
    const clamp = (n: number, limit: number) =>
      Math.max(-limit, Math.min(limit, n));
    const nearest = (index: number, from: number) =>
      from + wrap(index - from + count / 2) - count / 2;
    let position = current();
    let target = position;
    let velocity = 0;
    let pickup = 0;
    let pickupVelocity = 0;
    let lean = 0;
    let leanVelocity = 0;
    let frame = 0;
    let lastFrame = 0;
    let suppressClickUntil = 0;
    let drag: {
      id: number;
      x: number;
      y: number;
      dx: number;
      origin: number;
      axis: "x" | "y" | null;
      lastX: number;
      lastTime: number;
      velocity: number;
    } | null = null;
    function paint() {
      cards.forEach((card, index) => {
        const distance = nearest(index, position) - position;
        const abs = Math.abs(distance);
        const active = Math.max(0, 1 - abs);
        const lift = pickup * active;
        const tilt = lean * active;
        card.style.transform = `translateX(${distance * step()}px) translateY(${Math.min(abs, 2) * 15 - lift}px) rotate(${distance * 12 - 5 + tilt}deg) scale(${Math.max(0.5, 1 - abs * 0.25) + lift * 0.002})`;
        card.style.opacity = String(Math.max(0, 1 - abs * 0.65));
        card.style.boxShadow = `0 ${7 + lift}px ${18 + lift}px rgba(32,53,43,${0.09 * active})`;
        card.style.zIndex = String(10 - Math.round(abs * 2));
        card.style.pointerEvents = abs < 1.4 ? "auto" : "none";
        card.setAttribute("aria-hidden", String(abs >= 1.4));
        card.querySelector<HTMLElement>("[data-badge]")!.style.opacity = String(
          Math.max(0, 1 - abs * 2),
        );
      });
    }
    function tick(time: number) {
      const dt = Math.min((time - lastFrame) / 1000, 0.032);
      lastFrame = time;
      const pulling = drag?.axis === "x";
      // Track the pointer directly; carry its momentum into the release spring.
      if (!drag) {
        velocity += ((target - position) * 240 - velocity * 23) * dt;
        position += velocity * dt;
      }
      // Pickup and lean keep their own spring state across release. Switching these
      // off with a boolean caused the old one-frame vertical drop and rotation snap.
      const pickupTarget = pulling ? 6 : 0;
      const leanTarget =
        drag?.axis === "x" && time - drag.lastTime > 100
          ? 0
          : clamp(velocity * -1.1, 7);
      pickupVelocity +=
        ((pickupTarget - pickup) * 300 - pickupVelocity * 28) * dt;
      pickup += pickupVelocity * dt;
      leanVelocity += ((leanTarget - lean) * 260 - leanVelocity * 26) * dt;
      lean += leanVelocity * dt;
      const settled =
        !drag &&
        Math.abs(target - position) < 0.001 &&
        Math.abs(velocity) < 0.01 &&
        Math.abs(pickup) < 0.04 &&
        Math.abs(pickupVelocity) < 0.4 &&
        Math.abs(lean) < 0.04 &&
        Math.abs(leanVelocity) < 0.4;
      if (settled) {
        position = target;
        velocity = pickup = pickupVelocity = lean = leanVelocity = 0;
      }
      paint();
      frame = settled ? 0 : requestAnimationFrame(tick);
    }
    function settle() {
      cancelAnimationFrame(frame);
      frame = 0;
      if (motion.matches) {
        position = target;
        velocity = pickup = pickupVelocity = lean = leanVelocity = 0;
        paint();
      } else {
        lastFrame = performance.now();
        frame = requestAnimationFrame(tick);
      }
    }
    function choose(index: number) {
      if (latest.current.disabled) return;
      const person = SEARCH_SPEAKERS[wrap(index)];
      target = nearest(wrap(index), position);
      latest.current.onChange(person.slug, person.name);
      settle();
    }
    function finish(event: PointerEvent, cancelled = false) {
      if (!drag || drag.id !== event.pointerId) return;
      const gesture = drag;
      drag = null;
      stage.classList.remove(styles.dragging);
      if (stage.hasPointerCapture(event.pointerId))
        stage.releasePointerCapture(event.pointerId);
      if (gesture.axis !== "x") {
        settle();
        return;
      }
      suppressClickUntil = performance.now() + 350;
      const recent = event.timeStamp - gesture.lastTime < 100;
      velocity = recent ? gesture.velocity : 0;
      const flick =
        recent && Math.abs(velocity) > 2.5 && Math.abs(gesture.dx) > 12;
      if (
        !cancelled &&
        !latest.current.disabled &&
        (Math.abs(gesture.dx) > step() * 0.32 || flick)
      ) {
        choose(current() + (gesture.dx < 0 ? 1 : -1));
      } else {
        target = nearest(current(), position);
        if (cancelled) velocity = 0;
        settle();
      }
    }
    stage.onpointerdown = (event) => {
      if (
        latest.current.disabled ||
        !event.isPrimary ||
        event.button !== 0 ||
        drag
      )
        return;
      cancelAnimationFrame(frame);
      frame = 0;
      drag = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        dx: 0,
        origin: position,
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
      if (elapsed > 0) {
        const instantaneous =
          -(event.clientX - drag.lastX) / step() / (elapsed / 1000);
        drag.velocity = clamp(drag.velocity * 0.35 + instantaneous * 0.65, 7);
      }
      drag.lastX = event.clientX;
      drag.lastTime = event.timeStamp;
      drag.dx = dx;
      // Direct tracking near the center; resistance keeps a long pull playful and bounded.
      const pull = dx / step();
      const resisted =
        Math.abs(pull) <= 1
          ? pull
          : Math.sign(pull) *
            (1 + (1 - Math.exp(-(Math.abs(pull) - 1))) * 0.28);
      position = drag.origin - resisted;
      velocity = drag.velocity;
      if (!frame && !motion.matches) {
        lastFrame = performance.now();
        frame = requestAnimationFrame(tick);
      }
      paint();
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
      paint();
    });
    observer.observe(stage);
    repaint.current = () => {
      if (drag) return;
      target = nearest(current(), position);
      settle();
    };
    const motionChanged = () => {
      if (!drag) settle();
    };
    motion.addEventListener("change", motionChanged);
    paint();
    return () => {
      cancelAnimationFrame(frame);
      motion.removeEventListener("change", motionChanged);
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
      {SEARCH_SPEAKERS.map((person, index) => (
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
          {person.slug === "all" ? (
            <span className={styles.anyPortrait}>
              <UsersRound size={43} strokeWidth={1.4} />
              <span>Any speaker</span>
            </span>
          ) : (
            <span className={styles.portraitImage}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                data-speaker={person.slug}
                src={speakerPortrait(person.slug)}
                alt={person.name}
                draggable={false}
              />
            </span>
          )}
          <span data-badge className={styles.badge}>
            <Scissors size={20} />
          </span>
        </button>
      ))}
    </div>
  );
}
