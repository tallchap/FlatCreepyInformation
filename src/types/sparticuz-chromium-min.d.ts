declare module "@sparticuz/chromium-min" {
  const chromium: {
    executablePath(url?: string): Promise<string>;
    args: string[];
    headless: boolean | "new";
  };
  export default chromium;
}
