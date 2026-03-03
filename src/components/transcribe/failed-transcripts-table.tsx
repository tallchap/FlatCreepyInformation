import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import failedData from "@/data/failed-transcripts.json";

export function FailedTranscriptsTable() {
  const items = failedData.items || [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Failed Transcript Pulls</CardTitle>
        <CardDescription>
          Latest failed IDs with failure code. Source: {failedData.source}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <div className="text-sm text-muted-foreground">No failed items.</div>
        ) : (
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>YouTube</TableHead>
                  <TableHead>Failure Code</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="font-mono text-xs">{item.id}</TableCell>
                    <TableCell>
                      <a
                        href={item.youtubeLink}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        open
                      </a>
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {item.failureCode}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
