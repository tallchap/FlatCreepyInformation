import type { CSSProperties } from "react";

export const DEFAULT_ELON_PORTRAIT = "option-6" as const;

export const ELON_PORTRAITS = [
  {
    id: "option-1",
    label: "Direct gaze",
    position: "32% 0%",
    scale: 1.4,
    source:
      "https://www.thestandard.com.hk/world/article/333767/SpaceX-the-sprawling-company-targeting-the-stars-Mars-and-an-IPO",
  },
  {
    id: "option-2",
    label: "Dark suit",
    position: "50% 0%",
    scale: 1.3,
    source:
      "https://www.gqjapan.jp/car/news/20161024/elon-musk-its-basically-a-supercomputer-in-a-car",
  },
  {
    id: "option-3",
    label: "Black on black",
    position: "50% 0%",
    scale: 1.35,
    source:
      "https://www.motor.es/noticias/tesla-plan-elon-musk-incentivos-2025110801.html",
  },
  {
    id: "option-4",
    label: "Studio close-up",
    position: "50% 35%",
    scale: 1,
    source:
      "https://www.esquire.com/news-politics/a16681/elon-musk-interview-1212/",
  },
  {
    id: "option-5",
    label: "Quiet intensity",
    position: "50% 35%",
    scale: 1,
    source: "https://www.gq.com/story/elon-musk-mars-spacex-tesla-interview",
  },
  {
    id: "option-6",
    label: "Interview",
    position: "52% 0%",
    scale: 1.2,
    source:
      "https://www.cbsnews.com/news/extended-transcript-spacex-ceo-elon-musk-on-putting-boots-on-the-moon-and-mars/",
  },
  {
    id: "option-7",
    label: "Tight close-up",
    position: "52% 35%",
    scale: 1,
    source:
      "https://www.businessinsider.com/elon-musk-and-sec-battle-timeline-2019-3",
  },
  {
    id: "option-8",
    label: "Dramatic light",
    position: "50% 35%",
    scale: 1,
    source: "https://www.wired.com/story/neuralink-brain-implant-study-site/",
  },
  {
    id: "option-9",
    label: "Focused look",
    position: "50% 35%",
    scale: 1,
    source: "https://time.com/7177802/elon-musk-donald-trump-2024-election/",
  },
  {
    id: "option-10",
    label: "Deep in thought",
    position: "67% 35%",
    scale: 1.6,
    source:
      "https://disconnect.blog/elon-musk-doesnt-care-about-kids-he-cares-about-demographics-2/",
  },
] as const;

export type ElonPortrait =
  | "current"
  | "dark"
  | "stern"
  | "focused"
  | "shadow"
  | (typeof ELON_PORTRAITS)[number]["id"];

export function elonPortraitStyle(id: ElonPortrait): CSSProperties | undefined {
  const photo = ELON_PORTRAITS.find((photo) => photo.id === id);
  return photo
    ? {
        objectPosition: photo.position,
        transform: `scale(${photo.scale})`,
        transformOrigin: photo.position,
      }
    : undefined;
}
