import { useLocalStorage } from "usehooks-ts";

export function usePreface() {
  const DEFAULT_PREFACE = "you are reviewing a video transcript. here it is:";

  const [preface, setPreface] = useLocalStorage(
    "transcript-preface-text",
    DEFAULT_PREFACE
  );

  const resetPreface = () => {
    setPreface(DEFAULT_PREFACE);
  };

  return [preface, setPreface, resetPreface] as const;
}
