// YouTubeCleanPlayer — the YouTube iframe as a plain video surface for the
// editor (yt-only videos have no stored file to play).
//
//  - playerVars hide what they can: no controls, related videos, annotations,
//    keyboard or fullscreen.
//  - A transparent shield sits over the iframe and takes every mouse event, so
//    YouTube never sees a hover (no title bar) or a click; clicking the shield
//    toggles play/pause through the API.
//  - The iframe is taller than its box by 2 × CROP px and shifted up by CROP:
//    YouTube letterboxes the video into the middle and draws its title bar and
//    pause panel in the bands that the box clips away.
//
// The returned object has the same shape the editor builds for Bunny/GCS
// <video> elements, plus onTime() (the iframe API has no timeupdate event).

export const YT_CROP_PX = 60;

export interface CleanPlayer {
  seekTo(sec: number, allowSeekAhead?: boolean): void;
  getCurrentTime(): number;
  getDuration(): number;
  playVideo(): void;
  pauseVideo(): void;
  getPlayerState(): number;
  setPlaybackRate(r: number): void;
  getAvailableQualityLevels(): string[];
  getVideoData(): { title: string };
  destroy(): void;
  /** Polled every 100 ms while mounted. Returns an unsubscribe. */
  onTime(cb: (sec: number) => void): () => void;
  /** Off = clicks reach YouTube (e.g. to skip an ad). */
  setShield(on: boolean): void;
  /** Brief fade to black, used to mask the 300–800 ms embed seek. */
  flash(ms?: number): void;
}

let apiPromise: Promise<any> | null = null;
export function loadYouTubeApi(): Promise<any> {
  const w = window as any;
  if (w.YT?.Player) return Promise.resolve(w.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve) => {
    const prev = w.onYouTubeIframeAPIReady;
    w.onYouTubeIframeAPIReady = () => {
      try { prev?.(); } catch {}
      resolve(w.YT);
    };
    if (!document.querySelector('script[src="https://www.youtube.com/iframe_api"]')) {
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.body.appendChild(s);
    }
  });
  return apiPromise;
}

export function mountYouTubeCleanPlayer(
  container: HTMLElement,
  videoId: string,
  opts: {
    crop?: number;
    onReady?: (p: CleanPlayer) => void;
    onStateChange?: (state: number) => void;
    onError?: (code: number) => void;
  } = {},
): CleanPlayer {
  const crop = opts.crop ?? YT_CROP_PX;
  container.innerHTML = "";
  container.style.position = "relative";
  container.style.overflow = "hidden";
  container.style.backgroundColor = "#000";

  const frameBox = document.createElement("div");
  frameBox.dataset.testid = "yt-frame-box";
  Object.assign(frameBox.style, {
    position: "absolute", left: "0", right: "0", top: `-${crop}px`, height: `calc(100% + ${2 * crop}px)`,
  });
  const target = document.createElement("div");
  frameBox.appendChild(target);
  container.appendChild(frameBox);

  const shield = document.createElement("div");
  shield.dataset.testid = "yt-shield";
  Object.assign(shield.style, { position: "absolute", inset: "0", zIndex: "5", cursor: "pointer", background: "transparent" });
  container.appendChild(shield);

  // Our own poster until the first play (hides YouTube's big red play button),
  // and again once the video ends (hides the end screen).
  const poster = document.createElement("div");
  poster.dataset.testid = "yt-poster";
  Object.assign(poster.style, {
    position: "absolute", inset: "0", zIndex: "4", pointerEvents: "none", backgroundColor: "#000",
    backgroundImage: `url(https://i.ytimg.com/vi/${videoId}/maxresdefault.jpg), url(https://i.ytimg.com/vi/${videoId}/hqdefault.jpg)`,
    backgroundSize: "cover", backgroundPosition: "center", transition: "opacity 200ms ease",
  });
  container.appendChild(poster);

  const fade = document.createElement("div");
  Object.assign(fade.style, {
    position: "absolute", inset: "0", zIndex: "6", background: "#000", opacity: "0", pointerEvents: "none",
    transition: "opacity 120ms ease",
  });
  container.appendChild(fade);

  let yt: any = null;
  let ready = false;
  let destroyed = false;
  const listeners = new Set<(sec: number) => void>();
  const ticker = setInterval(() => {
    if (!ready || !listeners.size) return;
    const t = yt?.getCurrentTime?.();
    if (typeof t === "number") listeners.forEach((cb) => cb(t));
  }, 100);

  const api: CleanPlayer = {
    seekTo: (sec, allowSeekAhead = true) => yt?.seekTo?.(sec, allowSeekAhead),
    getCurrentTime: () => yt?.getCurrentTime?.() ?? 0,
    getDuration: () => yt?.getDuration?.() ?? 0,
    playVideo: () => yt?.playVideo?.(),
    pauseVideo: () => yt?.pauseVideo?.(),
    getPlayerState: () => yt?.getPlayerState?.() ?? -1,
    setPlaybackRate: (r) => yt?.setPlaybackRate?.(r),
    getAvailableQualityLevels: () => yt?.getAvailableQualityLevels?.() ?? [],
    getVideoData: () => yt?.getVideoData?.() ?? { title: "" },
    destroy: () => {
      destroyed = true;
      clearInterval(ticker);
      listeners.clear();
      try { yt?.destroy?.(); } catch {}
      container.innerHTML = "";
    },
    onTime: (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    setShield: (on) => { shield.style.pointerEvents = on ? "auto" : "none"; },
    flash: (ms = 350) => {
      fade.style.opacity = "1";
      setTimeout(() => { fade.style.opacity = "0"; }, ms);
    },
  };

  shield.addEventListener("click", () => {
    if (!ready) return;
    if (api.getPlayerState() === 1) api.pauseVideo();
    else api.playVideo();
  });

  loadYouTubeApi().then((YT) => {
    if (destroyed) return;
    yt = new YT.Player(target, {
      videoId,
      width: "100%",
      height: "100%",
      playerVars: {
        controls: 0, rel: 0, iv_load_policy: 3, disablekb: 1, fs: 0, playsinline: 1,
        enablejsapi: 1, origin: window.location.origin,
      },
      events: {
        onReady: () => {
          ready = true;
          const iframe = frameBox.querySelector("iframe");
          if (iframe) { iframe.style.width = "100%"; iframe.style.height = "100%"; iframe.setAttribute("tabindex", "-1"); }
          opts.onReady?.(api);
        },
        onStateChange: (e: any) => {
          // 1 playing, 3 buffering → video visible; 0 ended → poster back.
          if (e.data === 1 || e.data === 3 || e.data === 2) poster.style.opacity = "0";
          if (e.data === 0) poster.style.opacity = "1";
          opts.onStateChange?.(e.data);
        },
        onError: (e: any) => opts.onError?.(e.data),
      },
    });
  });

  return api;
}
