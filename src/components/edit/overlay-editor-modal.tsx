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
  bgColor: string;
  bgOpacity: number;
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
  const [bgColor, setBgColor] = useState(initial?.bgColor ?? "#000000");
  const [bgOpacity, setBgOpacity] = useState(initial?.bgOpacity ?? 50);
  const [dragging, setDragging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [hasTextBox, setHasTextBox] = useState(!!initial?.text);
  const [selectedThumb, setSelectedThumb] = useState(0);
  const canvasRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(800);

  // Track canvas width for proportional font scaling
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setCanvasWidth(entry.contentRect.width));
    ro.observe(el);
    setCanvasWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (document.getElementById("gfonts-overlay")) return;
    const link = document.createElement("link");
    link.id = "gfonts-overlay";
    link.rel = "stylesheet";
    link.href = FONTS_CSS_URL;
    document.head.appendChild(link);
  }, []);

  const thumbTimes = [
    Math.round(duration * 0.25),
    Math.round(duration * 0.50),
    Math.round(duration * 0.75),
  ];


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
    onSave({ text: text.trim(), xPct, yPct, fontSize, fontFamily, color, opacity, bgBox, bgColor, bgOpacity });
  };

  // Parse hex for color input sync
  const handleHexInput = (hex: string) => {
    const clean = hex.replace(/[^0-9a-fA-F#]/g, "");
    if (clean.match(/^#?[0-9a-fA-F]{6}$/)) {
      setColor(clean.startsWith("#") ? clean : `#${clean}`);
    }
  };

  const gcsUrl = `https://storage.googleapis.com/snippysaurus-clips/videos/${videoId}.mp4`;
  const thumbUrl = `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
  const scaledFontSize = fontSize / 1920 * canvasWidth;

  const hexToBgRgba = (hex: string, a: number) => {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${a})`;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70" onClick={onClose}>
      <div className="bg-gray-900 rounded-2xl shadow-2xl w-[92vw] max-w-[1000px] overflow-hidden" onClick={(e) => e.stopPropagation()}>

        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-gray-700">
          <h2 className="text-base font-semibold text-white">Text Overlay Editor</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-white text-xl leading-none">&times;</button>
        </div>

        {/* Main frame + thumbnails side by side */}
        <div className="px-5 pt-3 flex gap-2">
          {/* Main video canvas */}
          <div
            ref={canvasRef}
            className="relative flex-1 aspect-video bg-black rounded-lg overflow-hidden cursor-crosshair select-none"
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onClick={() => { if (editing) { setEditing(false); if (!text) setHasTextBox(false); } }}
          >
            {/* YouTube thumbnail — switches on thumbnail click */}
            <img
              src={[
                thumbUrl,
                `https://img.youtube.com/vi/${videoId}/sddefault.jpg`,
                `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
              ][selectedThumb] || thumbUrl}
              alt="Video frame"
              className="w-full h-full object-cover"
            />

            {/* Draggable text with edit/delete icons */}
            {hasTextBox && (
              <div
                className={`absolute select-none group ${dragging ? "cursor-grabbing" : "cursor-grab"}`}
                style={{
                  left: `${xPct * 100}%`,
                  top: `${yPct * 100}%`,
                  transform: "translate(0, -100%)",
                }}
                onClick={(e) => e.stopPropagation()}
                onPointerDown={(e) => {
                  if (editing) return;
                  if ((e.target as HTMLElement).closest("[data-action]")) return;
                  handlePointerDown(e);
                }}
              >
                {/* Action icons — top right of text */}
                {!editing && text && (
                  <div className="absolute -top-5 right-0 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      data-action="edit"
                      onClick={(e) => { e.stopPropagation(); setEditing(true); }}
                      className="w-5 h-5 flex items-center justify-center rounded bg-blue-600 text-white text-[10px] hover:bg-blue-500"
                      title="Edit text"
                    >
                      &#9998;
                    </button>
                    <button
                      data-action="delete"
                      onClick={(e) => { e.stopPropagation(); setText(""); setEditing(false); setHasTextBox(false); }}
                      className="w-5 h-5 flex items-center justify-center rounded bg-red-600 text-white text-[10px] hover:bg-red-500"
                      title="Remove text"
                    >
                      &times;
                    </button>
                  </div>
                )}

                {/* Text content */}
                <div
                  style={{
                    fontSize: `${scaledFontSize}px`,
                    fontFamily: `'${fontFamily}', sans-serif`,
                    color,
                    opacity: opacity / 100,
                    fontWeight: 700,
                    ...(bgBox ? { backgroundColor: hexToBgRgba(bgColor, bgOpacity / 100), padding: "4px 12px", borderRadius: 4 } : {}),
                    textShadow: bgBox ? "none" : "1px 1px 4px rgba(0,0,0,0.9)",
                    minWidth: 40,
                    minHeight: 20,
                  }}
                >
                  {editing ? (
                    <input
                      ref={inputRef}
                      value={text}
                      onChange={(e) => setText(e.target.value)}
                      onBlur={() => { setEditing(false); if (!text) setHasTextBox(false); }}
                      onKeyDown={(e) => { if (e.key === "Enter" && text) setEditing(false); }}
                      className="bg-transparent border-none outline-none text-inherit w-full min-w-[120px]"
                      style={{ fontSize: "inherit", color: "inherit", fontWeight: "inherit", fontFamily: "inherit" }}
                      placeholder="Type text..."
                    />
                  ) : (
                    <span>{text}</span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Small thumbnails stacked vertically */}
          <div className="flex flex-col gap-1.5 w-[80px] flex-shrink-0">
            {[
              { src: thumbUrl, label: "Main" },
              { src: `https://img.youtube.com/vi/${videoId}/sddefault.jpg`, label: "Alt 1" },
              { src: `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`, label: "Alt 2" },
            ].map((thumb, i) => (
              <button
                key={i}
                onClick={() => setSelectedThumb(i)}
                className={`aspect-video rounded overflow-hidden border-2 transition-colors ${
                  selectedThumb === i ? "border-green-500" : "border-gray-700 hover:border-gray-500"
                }`}
              >
                <img src={thumb.src} alt={thumb.label} className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        </div>

        {/* Controls row 1: Font, Size, Color+Hex, Opacity */}
        <div className="px-5 pt-3 grid grid-cols-4 gap-3">
          <div>
            <label className="text-[10px] text-gray-400 block mb-0.5">Font</label>
            <select value={fontFamily} onChange={(e) => setFontFamily(e.target.value)}
              className="w-full px-1.5 py-1 text-xs bg-gray-800 text-white border border-gray-600 rounded"
              style={{ fontFamily: `'${fontFamily}', sans-serif` }}>
              {GOOGLE_FONTS.map((f) => <option key={f} value={f} style={{ fontFamily: `'${f}', sans-serif` }}>{f}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] text-gray-400 block mb-0.5">Size: {fontSize}px</label>
            <input type="range" min={24} max={192} value={fontSize} onChange={(e) => setFontSize(Number(e.target.value))} className="w-full" />
          </div>
          <div>
            <label className="text-[10px] text-gray-400 block mb-0.5">Color</label>
            <div className="flex gap-1">
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="w-8 h-7 rounded cursor-pointer flex-shrink-0" />
              <input type="text" value={color} onChange={(e) => handleHexInput(e.target.value)}
                className="flex-1 px-1.5 py-0.5 text-xs bg-gray-800 text-white border border-gray-600 rounded font-mono min-w-0" />
            </div>
          </div>
          <div>
            <label className="text-[10px] text-gray-400 block mb-0.5">Opacity: {opacity}%</label>
            <input type="range" min={10} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="w-full" />
          </div>
        </div>

        {/* Controls row 2: Background box */}
        <div className="px-5 pt-2 pb-3 grid grid-cols-4 gap-3">
          <div className="flex items-center">
            <label className="flex items-center gap-1.5 text-xs text-gray-300 cursor-pointer">
              <input type="checkbox" checked={bgBox} onChange={(e) => setBgBox(e.target.checked)} />
              Background
            </label>
          </div>
          {bgBox && (
            <>
              <div>
                <label className="text-[10px] text-gray-400 block mb-0.5">BG Color</label>
                <div className="flex gap-1">
                  <input type="color" value={bgColor} onChange={(e) => setBgColor(e.target.value)} className="w-8 h-7 rounded cursor-pointer flex-shrink-0" />
                  <input type="text" value={bgColor} onChange={(e) => { const v = e.target.value; if (v.match(/^#?[0-9a-fA-F]{0,6}$/)) setBgColor(v.startsWith("#") ? v : `#${v}`); }}
                    className="flex-1 px-1.5 py-0.5 text-xs bg-gray-800 text-white border border-gray-600 rounded font-mono min-w-0" />
                </div>
              </div>
              <div>
                <label className="text-[10px] text-gray-400 block mb-0.5">BG Opacity: {bgOpacity}%</label>
                <input type="range" min={10} max={100} value={bgOpacity} onChange={(e) => setBgOpacity(Number(e.target.value))} className="w-full" />
              </div>
            </>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-gray-700">
          <div className="flex gap-2">
            {!hasTextBox && (
              <button
                onClick={() => { setHasTextBox(true); setEditing(true); setXPct(0.5); setYPct(0.5); }}
                className="px-4 py-1.5 text-xs font-semibold text-white rounded-lg"
                style={{ backgroundColor: "#DC2626" }}
              >
                Add Text
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-3 py-1.5 text-xs text-gray-400 hover:text-white border border-gray-600 rounded-lg">Cancel</button>
            <button onClick={handleSave} disabled={!text.trim()} className="px-5 py-1.5 text-xs font-medium text-white bg-green-600 hover:bg-green-500 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed">Save</button>
          </div>
        </div>
      </div>
    </div>
  );
}
