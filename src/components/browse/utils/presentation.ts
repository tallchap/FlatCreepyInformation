import type { Speaker } from "./types";

export const PAGE_SIZE = 20;
export function initialLetter(name: string) {
  const first = name.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").charAt(0).toUpperCase();
  return /^[A-Z]$/.test(first) ? first : "#";
}
export function initials(name: string) {
  return name.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0]).join("");
}
export function avatarColor(name: string) {
  const hash = Array.from(name).reduce((sum, c) => sum + c.codePointAt(0)!, 0);
  return ["#1f2e25", "#7eb04e", "#c97a4a"][hash % 3];
}
export function sortSpeakers(speakers: Speaker[], sort: string, letter: string, query: string) {
  const q = query.trim().toLocaleLowerCase();
  return speakers.filter((s) => (letter === "All" || initialLetter(s.name) === letter) && s.name.toLocaleLowerCase().includes(q))
    .sort((a, b) => {
      const difference = sort === "recent"
        ? (Date.parse(b.updatedAt || "") || 0) - (Date.parse(a.updatedAt || "") || 0)
        : sort === "alphabetical" ? 0 : b.videoCount - a.videoCount;
      return difference || a.name.localeCompare(b.name);
    });
}
export function yearOf(date: string) {
  return /^\d{4}-\d{2}-\d{2}/.test(date) ? date.slice(0, 4) : "Undated";
}
export function displayDate(date: string) {
  const value = new Date(date);
  return Number.isNaN(value.getTime()) ? "Date unavailable" : value.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}
export function duration(ms: number) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function pageNumbers(page: number, total: number): (number | string)[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const keep = new Set([1, total, page - 1, page, page + 1]);
  if (page <= 3) [2, 3, 4, 5].forEach((n) => keep.add(n));
  if (page >= total - 2) [total - 4, total - 3, total - 2, total - 1].forEach((n) => keep.add(n));
  const pages = [...keep].filter((n) => n >= 1 && n <= total).sort((a, b) => a - b);
  return pages.flatMap((n, i) => i && n - pages[i - 1] > 1 ? [`gap-${n}`, n] : [n]);
}

// Older clip records store a GCS URI; browsers need its HTTPS equivalent.
export function playableMediaUrl(raw: string): string | null {
  if (raw.startsWith("gs://")) return `https://storage.googleapis.com/${raw.slice(5)}`;
  try { const url = new URL(raw); return url.protocol === "https:" ? url.href : null; }
  catch { return null; }
}
