import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import ts from "typescript";
async function moduleUrl(file) {
  const source = await fs.readFile(new URL(file, import.meta.url), "utf8");
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext },
  });
  if (outputText.includes("@/lib/editor-link"))
    outputText = outputText.replace(
      "@/lib/editor-link",
      await moduleUrl("../src/lib/editor-link.ts"),
    );
  return `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`;
}
async function load(file) {
  return import(await moduleUrl(file));
}
const { editorHref, timestampSeconds, readEditorRange, clampEditorRange } =
  await load("../src/lib/editor-link.ts");
const { validateSegments } = await load("../src/lib/clip-segments.ts");
const read = (q) => readEditorRange(new URLSearchParams(q));
test("one canonical editor link preserves zero and fractional timestamps", () => {
  assert.equal(editorHref("abcdefghijk"), "/edit?v=abcdefghijk");
  assert.equal(
    editorHref("abcdefghijk", 0, 10),
    "/edit?v=abcdefghijk&start=0&end=10",
  );
  assert.equal(
    editorHref("abcdefghijk", 12.45, 14.8),
    "/edit?v=abcdefghijk&start=12.45&end=14.8",
  );
  for (const start of [-1, NaN, Infinity, null])
    assert.equal(editorHref("abcdefghijk", start, 15), "/edit?v=abcdefghijk");
  assert.equal(
    editorHref("abcdefghijk", 10, 9),
    "/edit?v=abcdefghijk&start=10",
  );
});
test("legacy bookmarks open the first valid range and disclose omitted ranges", () => {
  assert.deepEqual(read("seg=60-76,100-120"), {
    range: { in: 60, out: 76 },
    hadMultiple: true,
  });
  assert.deepEqual(read("seg=bad,20-10,60.25-76.5"), {
    range: { in: 60.25, out: 76.5 },
    hadMultiple: false,
  });
  assert.deepEqual(read("t=1h2m3.5s"), {
    range: { in: 3723.5, out: 3733.5 },
    hadMultiple: false,
  });
  assert.deepEqual(read("start=0&end=15"), {
    range: { in: 0, out: 15 },
    hadMultiple: false,
  });
  assert.deepEqual(read("start=12&end=5"), {
    range: { in: 12, out: 22 },
    hadMultiple: false,
  });
  assert.deepEqual(read("v=abcdefghijk"), { range: null, hadMultiple: false });
});
test("malformed or overflowing timestamps never reach the player", () => {
  for (const value of [
    "",
    "bad",
    "-1",
    "Infinity",
    "NaN",
    "1:20",
    "9".repeat(400),
    "9".repeat(400) + "h",
  ])
    assert.equal(timestampSeconds(value), undefined);
  assert.deepEqual(read("seg=0-" + "9".repeat(400)), {
    range: null,
    hadMultiple: false,
  });
});
test("linked ranges clamp at both ends and remain at least one second", () => {
  assert.deepEqual(clampEditorRange({ in: 95, out: 120 }, 100), {
    in: 95,
    out: 100,
  });
  assert.deepEqual(clampEditorRange({ in: 150, out: 160 }, 100), {
    in: 99,
    out: 100,
  });
  assert.deepEqual(clampEditorRange({ in: -4, out: 0 }, 100), {
    in: 0,
    out: 1,
  });
  assert.deepEqual(clampEditorRange({ in: 10, out: 10.1 }, 100), {
    in: 10,
    out: 11,
  });
  assert.deepEqual(clampEditorRange({ in: 10, out: 20 }, 0), {
    in: 10,
    out: 20,
  });
});
test("public export accepts one range, rejects multiple, invalid and oversized requests", () => {
  assert.equal(validateSegments([{ in: 0, out: 660 }], 700), null);
  assert.equal(validateSegments([{ in: 12.25, out: 13.25 }], 700), null);
  for (const ranges of [
    null,
    [],
    [
      { in: 0, out: 10 },
      { in: 20, out: 30 },
    ],
    [{ in: 0, out: 661 }],
    [{ in: 10, out: 10.9 }],
    [{ in: -1, out: 10 }],
    [{ in: NaN, out: 10 }],
    [{ in: 0, out: Infinity }],
    [{ in: 0, out: "10" }],
  ])
    assert.equal(typeof validateSegments(ranges, 700), "string");
  assert.match(
    validateSegments([{ in: 99, out: 110 }], 100),
    /after the video/,
  );
});

const { formatChatContent } = await load("../src/lib/chat-content.ts");
test("all chat YouTube forms retain timestamps and open the full-video editor", () => {
  for (const text of [
    "[Quote](youtube:abcdefghijk:62.5)",
    "[Quote](https://youtu.be/abcdefghijk?t=62.5)",
    "[Quote](https://www.youtube.com/watch?v=abcdefghijk&t=1m2.5s)",
    "https://youtu.be/abcdefghijk?t=62.5",
    "https://www.youtube.com/watch?v=abcdefghijk&start=62.5",
    "[Quote](https://m.youtube.com/shorts/abcdefghijk?t=62.5)",
  ]) {
    const html = formatChatContent(text);
    assert.equal((html.match(/<a /g) || []).length, 1, html);
    assert.match(html, /href="\/edit\?v=abcdefghijk&start=62.5"/);
    assert.match(html, /data-video-id="abcdefghijk"/);
    assert.match(html, /data-start-sec="62.5"/);
  }
});
test("bare and markdown video URLs never create nested links; other links remain external", () => {
  assert.match(formatChatContent("https://youtu.be/abcdefghijk."), /start=0/);
  assert.equal(
    (
      formatChatContent(
        "[https://youtu.be/abcdefghijk](https://youtu.be/abcdefghijk)",
      ).match(/<a /g) || []
    ).length,
    1,
  );
  const external = formatChatContent("[Source](https://example.com/article)");
  assert.match(external, /href="https:\/\/example.com\/article"/);
  assert.doesNotMatch(external, /data-video-id/);
  assert.match(
    formatChatContent("A [bracketed [title]](youtube:abcdefghijk:0)"),
    /bracketed \[title\]/,
  );
});

test("numbered video results remain clickable citations, while follow-ups retain their behavior", () => {
  const html = formatChatContent(
    "1. [**Quote**](youtube:abcdefghijk:20)\n2. Find another quote.",
  );
  assert.equal((html.match(/data-suggestion=/g) || []).length, 1);
  assert.match(html, /<strong>Quote<\/strong>/);
  assert.match(html, /data-suggestion="Find%20another%20quote"/);
});
