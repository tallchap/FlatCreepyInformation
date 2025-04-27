"use client";

import { Loader } from "@/components/loader";
import { useActionState } from "react";
import { ErrorMessage } from "../error-message";
import { SearchForm } from "./search-form";
import { searchTranscript } from "./utils/actions";
import { VideoResult } from "./video-result";
import { VideoResult as VideoResultType } from "./utils/types";
import { Export } from "./export";
export function App() {
  const [state, action, isPending] = useActionState(searchTranscript, null);
  return (
    <>
      <SearchForm
        action={action}
        isPending={isPending}
        formData={state?.formData}
      />
      {isPending && <Loader className="mx-auto" />}
      {state?.error && <ErrorMessage error={state?.error} />}
      {state?.results && !isPending && (
        <div className="flex justify-between items-center">
          <p className="text-sm text-gray-600">
            Found {state.total} matching instances across {state.uniqueVideos}{" "}
            videos
          </p>
          <Export formData={state.formData} />
        </div>
      )}
      {state?.results?.length === 0 ? (
        <div className="bg-white p-8 rounded-lg shadow text-center">
          <p className="text-gray-700">
            No results found for your search criteria. Try adjusting your search
            terms.
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          {state?.results?.map((video: VideoResultType, index: number) => (
            <VideoResult video={video} key={`${video.ID}-${index}`} />
          ))}
        </div>
      )}
    </>
  );
}
