import { Download } from "lucide-react";
import { Button } from "../ui/button";
import { exportTranscripts } from "./utils/actions";
import { toast } from "sonner";
import { useState } from "react";

export function Export({ formData }: { formData: FormData }) {
  const [isExporting, setIsExporting] = useState(false);
  const handleExport = async () => {
    try {
      setIsExporting(true);
      const response = await exportTranscripts(null, formData);
      if ("error" in response) {
        toast.error(response.error);
        return;
      }

      // Create a Blob from the plain text
      const blob = new Blob([response.plainText], {
        type: "text/plain;charset=utf-8",
      });
      const url = URL.createObjectURL(blob);

      // Create a download link and trigger the download
      const a = document.createElement("a");
      a.href = url;
      a.download = response.fileName;
      document.body.appendChild(a);
      a.click();

      // Clean up
      URL.revokeObjectURL(url);
      document.body.removeChild(a);
      toast.success("Export successful");
    } catch (error) {
      toast.error("Error exporting transcripts");
      console.error(error);
    } finally {
      setIsExporting(false);
    }
  };
  return (
    <Button onClick={handleExport} disabled={isExporting}>
      <Download />
      {isExporting ? "Exporting..." : "Export as Text"}
    </Button>
  );
}
