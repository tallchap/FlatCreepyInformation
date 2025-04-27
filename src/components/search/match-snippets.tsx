function stripTimestamps(text: string): string {
  return text.replace(/\d+(\.\d+)?:\s/g, "");
}

export function MatchSnippets({
  snippets,
  className,
}: {
  snippets: string[];
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="text-sm text-gray-800 mb-2 font-medium">
        Matching content:
      </div>
      {snippets.map((snippet, index) => (
        <div
          key={index}
          className="bg-gray-50 p-3 rounded text-sm mb-2"
          dangerouslySetInnerHTML={{ __html: stripTimestamps(snippet) }}
        />
      ))}
    </div>
  );
}
