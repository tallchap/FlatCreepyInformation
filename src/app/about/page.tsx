
// src/app/about/page.tsx
import Link from "next/link";

export default function AboutPage() {
  return (
    <section className="container mx-auto max-w-4xl">
      <div className="mb-12">
        <div className="bg-white rounded-lg shadow-md p-4">
          <p className="text-lg mb-6">
            Snippysaurus helps you find clip-worthy quotes from 3 000+ AI-focused
            video transcripts.
          </p>

          <ul className="space-y-4 pl-5 list-disc">
            <li>
              Use{" "}
              <Link href="/" className="text-blue-600 hover:underline font-medium">
                Search
              </Link>{" "}
              to find keywords within video transcripts.
            </li>

            <li>
              Use <span className="font-medium">Customize Preface</span> and then
              copy-paste a modified transcript onto your device.
            </li>

            <li>
              <span className="font-medium">Export</span> all the results from a
              search into a plain-text file.
            </li>

            <li>
              Use{" "}
              <Link
                href="/transcribe"
                className="text-blue-600 hover:underline font-medium"
              >
                Transcribe
              </Link>{" "}
              to add new transcripts, or
              <span className="font-medium"> Bulk Import</span> up to 30 videos at
              a time.
            </li>
          </ul>
        </div>
      </div>

      <h2 className="text-2xl font-semibold text-gray-700 mb-4 text-center">
        Explore what's in the Database
      </h2>

      <div className="flex justify-center">
        <iframe
          height={800}
          src="https://lookerstudio.google.com/embed/reporting/f5dbd726-4e57-4f54-8089-45513c4c7ab9/page/wTwFF"
          allowFullScreen
          sandbox="allow-storage-access-by-user-activation allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        />
      </div>
    </section>
  );
}
import Link from "next/link";

export default function AboutPage() {
  return (
    <section className="container mx-auto max-w-4xl space-y-8">
      {/* Existing content would be here */}

      {/* ─────────── NEW: one-click downloader ─────────── */}
      <div className="text-center">
        <form action="/api/download" method="post">
          <button
            type="submit"
            className="px-6 py-3 rounded-lg bg-red-600 text-white text-lg font-semibold shadow hover:bg-red-700"
          >
            Download the demo video
          </button>
        </form>
      </div>
    </section>
  );
}
