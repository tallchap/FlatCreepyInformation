export function ErrorMessage({ error }: { error?: string }) {
  return (
    <div className="mt-8 bg-red-50 border-l-4 border-red-400 p-4 rounded">
      <div className="flex">
        <div className="ml-3">
          <p className="text-sm text-red-700">{error || "An error occurred"}</p>
        </div>
      </div>
    </div>
  );
}
