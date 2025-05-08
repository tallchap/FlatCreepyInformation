"use client";

import { Loader } from "@/components/loader";
import { useActionState, useState } from "react";
import { ErrorMessage } from "../error-message";
import { SearchForm } from "./search-form";
import { searchTranscript } from "./utils/actions";
import { VideoResult } from "./video-result";
import { VideoResult as VideoResultType } from "./utils/types";
import { Export } from "./export";
export function App() {
  const [data, setData] = useState<Record<string, any>>();
  const [isLoading, setIsLoading] = useState(false);
  return (
    <>
      <SearchForm
        data={data}
        setData={setData}
        isLoading={isLoading}
        setIsLoading={setIsLoading}
      />
      {isLoading && <Loader className="mx-auto" />}
      {data?.error && <ErrorMessage error={data.error} />}
      {data?.results && data?.results?.length > 0 && !isLoading && (
        <div className="flex justify-between items-center">
          <p className="text-sm text-gray-600">
            Found {data.total} matching instances across {data.uniqueVideos}{" "}
            videos
          </p>
          <Export inputs={data.inputs} />
        </div>
      )}
      {data?.results?.length === 0 ? (
        <div className="bg-white p-8 rounded-lg shadow text-center">
          <p className="text-gray-700">
            No results found for your search criteria. Try adjusting your search
            terms.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {data?.results?.map((video: VideoResultType, index: number) => (
            <VideoResult video={video} key={`${video.ID}-${index}`} />
          ))}
        </div>
      )}
    </>
  );
}
