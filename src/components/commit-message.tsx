import { useState, type ReactNode } from "react";
import { ChevronDownIcon, ChevronUpIcon } from "lucide-react";
import { useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/** Keep the subject and metadata visible while long messages scroll independently. */
export function CommitMessage({ message, actions, metadata, className }: {message: string; actions?: ReactNode; metadata?: ReactNode; className?: string}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [subject, ...lines] = message.replace(/\r\n/g, "\n").trimEnd().split("\n");
  const body = lines.join("\n").replace(/^\n+/, "");
  const collapsible = body.length > 160 || body.split("\n").length > 3;
  return <div className={cn("flex max-h-[70%] min-h-0 shrink-0 flex-col px-3 py-2", className)}>
    <div className="flex shrink-0 items-start gap-1">
      <h2 title={subject} className="min-w-0 flex-1 line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]">{subject || t("git.ui.no_message")}</h2>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
    </div>
    {metadata ? <div className="shrink-0">{metadata}</div> : null}
    {body ? <>
      <div className={cn("mt-2 min-h-0 text-xs leading-5 text-muted-foreground", expanded || !collapsible ? "max-h-32 overflow-auto" : "overflow-hidden")}>
        <div className={cn("select-text whitespace-pre-wrap [overflow-wrap:anywhere]", collapsible && !expanded && "line-clamp-3")}>{body}</div>
      </div>
      {collapsible ? <Button type="button" variant="ghost" size="xs" className="mt-1 -ml-1 h-5 shrink-0 self-start px-1 text-[11px] text-muted-foreground" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
        {expanded ? <ChevronUpIcon /> : <ChevronDownIcon />}{t(expanded ? "git-files.message.showLess" : "git-files.message.showMore")}
      </Button> : null}
    </> : null}
  </div>;
}
