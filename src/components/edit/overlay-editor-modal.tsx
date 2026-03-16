"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const GOOGLE_FONTS = [
  "Roboto", "Open Sans", "Lato", "Montserrat", "Oswald", "Raleway", "Poppins",
  "Nunito", "Ubuntu", "Merriweather", "Playfair Display", "Bebas Neue", "Anton",
  "Righteous", "Lobster", "Pacifico", "Bangers", "Permanent Marker", "Press Start 2P",
  "Black Ops One", "Bungee", "Caveat", "Dancing Script", "Satisfy", "Alfa Slab One",
  "Archivo Black", "Barlow Condensed", "Cinzel", "Comfortaa", "Fjalla One",
];

const FONTS_CSS_URL = `https://fonts.googleapis.com/css2?${GOOGLE_FONTS.map(f => `family=${f.replace(/ /g, "+")}`).join("&")}&display=swap`;

export interface OverlaySettings {
  text: string;
  xPct: number;
  yPct: number;
  fontSize: number;
  fontFamily: string;
  color: string;
  opacity: number;
  bgBox: boolean;
}

interface Props {
  videoId: string;
  gcsAvailable: boolean;
  currentTime: number;
  duration: number;
  onSave: (settings: OverlaySettings) => void;
  onClear: () => void;
  onClose: () => void;
  initial?: OverlaySettings | null;
}

export function OverlayEditorModal({ videoId, gcsAvailable, currentTime, duration, onSave, onClear, onClose, initial }: Props) {
  const [text, setText] = useState(initial?.text || "");
  const [xPct, setXPct] = useState(initial?.xPct ?? 0.05);
  const [yPct, setYPct] = useState(initial?.yPct ?? 0.85);
  const [fontSize, setFontSize] = useState(initial?.fontSize ?? 48);
  const [fontFamily, setFontFamily] = useState(initial?.fontFamily ?? "Roboto");
  const [color, setColor] = useState(initial?.color ?? "#ffffff");
  const [opacity, setOpacity] = useState(initial?.opacity ?? 100);
  const [bgBox, setBgBox] = useState(initial?.bgBox ?? true);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(!initial?.text);
  const [selectedThumb, setSelectedThumb] = useState(1); // 0, 1, 2
  const canvasRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mainVideoRef = useRef<HTMLVideoElement>(null);

  // Load Google Fonts
  useEffect(() => {
    if (document.getElementById("gfonts-overlay")) return;
    const link = document.createElement("link");
    link.id = "gfonts-overlay";
    link.rel = "stylesheet";
    link.href = FONTS_CSS_URL;
    document.head.appendChild(link);
  }, []);

  // Thumbnail timestamps at 25%, 50%, 75% of video
  const thumbTimes = [
    Math.round(duration * 0.25),
    Math.round(duration * 0.50),
    Math.round(duration * 0.75),
  ];

  // Seek main video when thumbnail selected
  useEffect(() => {
    if (mainVideoRef.current) {
      mainVideoRef.current.currentTime = thumbTimes[selectedThumb] || 0;
    }
  }, [selectedThumb]);

  useEffect(() => {
    if (editing && inputRef.current) inputRef.current.focus();
  }, [editing]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (editing) return;
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDragging(true);
  }, [editing]);

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging || !canvasRef.current) return;
    const rect = canvasRef.current.getBoundingClientRect();
    setXPct(Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
    setYPct(Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)));
  }, [dragging]);

  const handlePointerUp = useCallback(() => setDragging(false), []);

  const handleSave = () => {
    if (!text.trim()) return;
    onSave({ text: text.trim(), xPct, yPct, fontSize, fontFamily, color, opacity, bgBox });
  };

  const gcsUrl = `https://storage.googleapis.com/snippysaurus-clips/videos/${videoId}.mp4`;
  const thumbUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
  const scaledFontSize = fontSize * 0.35;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-gray-900 rounded-2xl shadow-2xl w-[90vw] max-w-[960px] overflow-hidden max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-700">
          <h2 className="text-lg font-semibold text-white">Text Overlay Editor</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl">&times;</button>
        </div>

        {/* Thumbnail picker */}
        {gcsAvailable && (
          <div className="px-6 pt-4 flex gap-2">
            {thumbTimes.map((t, i) => (
              <button
                key={i}
                onClick={() => setSelectedThumb(i)}
                className={`relative w-1/3 aspect-video rounded-lg overflow-hidden border-2 transition-colors ${
                  selectedThumb === i ? "border-green-500" : "border-gray-700 hover:border-gray-500"
                }`}
              >
                <video
                  src={`${gcsUrl}#t=${t}`}
                  className="w-full h-full object-cover"
                  preload="metadata"
                  muted
                />
                <span className="absolute bottom-1 right-1 text-[10px] text-white bg-black/60 px-1 rounded">
                  {Math.floor(t / 60)}:{String(t % 60).padStart(2, "0")}
                </span>
              </button>
            ))}
          </div>
        )}

        {/* Video frame + draggable text */}
        <div className="px-6 pt-3">
          <div
            ref={canvasRef}
            className="relative aspect-video bg-black rounded-lg overflow-hidden cursor-crosshair select-none"
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          >
            {gcsAvailable ? (
              <video
                ref={mainVideoRef}
                src={`${gcsUrl}#t=${thumbTimes[selectedThumb]}`}
                className="w-full h-full object-contain"
                preload="metadata"
                muted
              />
            ) : (
              <img src={thumbUrl} alt="Video frame" className="w-full h-full object-contain" />
            )}

            {/* Draggable text */}
            <div
              className={`absolute select-none ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
              style={{
                left: `${xPct * 100}%`,
                top: `${yPct * 100}%`,
                transform: "translate(0, -100%)",
                fontSize: `${scaledFontSize}px`,
                fontFamily: `'${fontFamily}', sans-serif`,
                color,
                opacity: opacity / 100,
                fontWeight: 700,
                ...(bgBox ? { backgroundColor: "rgba(0,0,0,0.5)", padding: "4px 12px", borderRadius: 4 } : {}),
                textShadow: bgBox ? "none" : "1px 1px 4px rgba(0,0,0,0.9)",
                minWidth: 40,
                minHeight: 20,
              }}
              onPointerDown={handlePointerDown}
              onDoubleClick={() => setEditing(true)}
            >
              {editing ? (
                <input
                  ref={inputRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onBlur={() => setEditing(false)}
                  onKeyDown={(e) => { if (e.key === "Enter") setEditing(false); }}
                  className="bg-transparent border-none outline-none text-inherit w-full min-w-[120px]"
                  style={{ fontSize: "inherit", color: "inherit", fontWeight: "inherit", fontFamily: "inherit" }}
                  placeholder="Type text..."
                />
              ) : (
                <span>{text || "Double-click to type"}</span>
              )}
            </div>

            {!text && !editing && (
              <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                <span className="text-gray-400 text-sm bg-black/50 px-3 py-1 rounded">Double-click the text to edit, drag to position</span>
              </div>
            )}
          </div>
        </div>

        {/* Controls */}
        <div className="px-6 py-4 grid grid-cols-2 sm:grid-cols-5 gap-3">
          <div className="col-span-2 sm:col-span-1">
            <label className="text-xs text-gray-400 block mb-1">Font</label>
            <select
              value={fontFamily}
              onChange={(e) => setFontFamily(e.target.value)}
              className="w-full px-2 py-1.5 text-sm bg-gray-800 text-white border border-gray-600 rounded"
              style={{ fontFamily: `'${fontFamily}', sans-serif` }}
            >
              {GOOGLE_FONTS.map((f) => (
                <option key={f} value={f} style={{ fontFamily: `'${f}', sans-serif` }}>{f}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Size: {fontSize}px</label>
            <input type="range" min={24} max={96} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} className="w-full" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Color</label>
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="w-full h-8 rounded cursor-pointer" />
          </div>
          <div>
            <label className="text-xs text-gray-400 block mb-1">Opacity: {opacity}%</label>
            <input type="range" min={10} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="w-full" />
          </div>
          <div className="flex items-end">
            <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
              <input type="checkbox" checked={bgBox} onChange={(e) => setBgBox(e.target.checked)} />
              Background box
            </label>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-gray-700">
          <button onClick={() => { onClear(); onClose(); }} className="px-4 py-2 text-sm text-red-400 hover:text-red-300">
            Clear Overlay
          </button>
          <div className="flex gap-3">
            <button onClick={onClose} className="px-4 py-2 text-sm text-gray-400 hover:text-white border border-gray-600 rounded-lg">Cancel</button>
            <button
              onClick={handleSave}
              disabled={!text.trim()}
              className="px-6 py-2 text-sm font-medium text-white bg-green-600 hover:bg-green-500 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
