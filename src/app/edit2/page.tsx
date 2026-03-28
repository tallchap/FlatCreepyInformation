import { ClipEditor } from "@/components/edit/clip-editor";

export default function EditPage2() {
  return (
    <div className="max-w-5xl mx-auto px-4 py-8">
      <ClipEditor cdnBaseUrl="https://cdn.snippysaurus.com" />
    </div>
  );
}
