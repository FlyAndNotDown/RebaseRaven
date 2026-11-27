import { cn } from "@/lib/utils";

/** Clip the shared prefix first. Keep the path itself in reading and copy order. */
export function PathLabel({ path, title = path, className }: { path: string; title?: string; className?: string }) {
  return <span dir="rtl" title={title} className={cn("block min-w-0 max-w-full truncate text-left font-mono", className)}>
    <bdi dir="ltr">{path}</bdi>
  </span>;
}
