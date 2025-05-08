import Link from "next/link";

export default function AboutPage() {
  return (
    <section className="container mx-auto max-w-4xl">
      <div className="mb-12">
        <div className="bg-white rounded-lg shadow-md p-4">
          <p className="text-lg mb-6">
            Snippysaurus helps you find clipworthy quotes from 3,000+ video
            transcripts focused on artificial intelligence.
          </p>
          <ul className="space-y-4 pl-5 list-disc">
            <li className="ml-1">
              Use{" "}
              <Link
                href="/"
                className="text-blue-600 hover:underline font-medium"
              >
                Search
              </Link>{" "}
              to find keywords within video transcripts.
            </li>
            <li className="ml-5">
              Use <span className="font-medium">Customize Preface</span> and
              then copy-paste a modified transcript onto your device.
            </li>
            <li className="ml-5">
              <span className="font-medium">Export</span> all the results from a
              search into a plaintext file.
            </li>
            <li className="ml-1">
              Use{" "}
              <Link
                href="/transcribe"
                className="text-blue-600 hover:underline font-medium"
              >
                Transcribe
              </Link>{" "}
              to add new transcripts to the database.
              <li className="ml-5">
                <span className="font-medium">Bulk Import </span>
                up to 30 videos at a time.
              </li>
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
        ></iframe>
      </div>
    </section>
  );
}
