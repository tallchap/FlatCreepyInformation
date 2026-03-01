import { BrowseSpeakersContainer } from "@/components/browse/browse-speakers";

export default function BrowsePage() {
  return (
    <section className="container mx-auto max-w-6xl flex flex-col gap-4">
      <h1 className="text-2xl font-bold text-gray-800">Browse by Speaker</h1>
      <BrowseSpeakersContainer />
    </section>
  );
}
