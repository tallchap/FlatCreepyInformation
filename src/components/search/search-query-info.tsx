import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Info } from "lucide-react";

export function SearchQueryInfo() {
  return (
    <Popover>
      <PopoverTrigger>
        <Info size={16} />
      </PopoverTrigger>
      <PopoverContent>
        <div className="p-2 bg-blue-50 rounded-md text-sm">
          <p className="font-medium">Search Tips:</p>

          <p>
            Use an asterisk <code className="bg-gray-100 px-2 rounded">*</code>{" "}
            at the end of a word to match variations:
          </p>

          <ul className="list-disc pl-10 ml-2">
            <li>
              <code className="bg-gray-100 px-1 rounded">program*</code> will
              match program, programs, programming, etc.
            </li>
          </ul>

          <p className="mt-3">Use "OR" to search for multiple keywords:</p>

          <ul className="list-disc pl-10 ml-2">
            <li>coding OR machine learning OR drone OR program*</li>
          </ul>

          <p className="mt-3">Filter by speaker name:</p>

          <ul className="list-disc pl-10 ml-2">
            <li>Hinton</li>
            <li>Yoshua</li>
          </ul>
        </div>
      </PopoverContent>
    </Popover>
  );
}
