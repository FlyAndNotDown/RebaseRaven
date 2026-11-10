import { useState } from "react";
import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { t, useTranslation } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export function withCurrent(options: string[], current: string) {
  if (!current || options.includes(current)) return options;
  return [current, ...options];
}

export function P4FilterMenu({
  label,
  value,
  emptyLabel,
  pinned,
  options,
  onOpen,
  onChange,
}: {
  label: string;
  value: string;
  emptyLabel: string;
  pinned?: { label: string; value: string };
  options: string[];
  onOpen: () => void;
  onChange: (value: string) => void;
}) {
  useTranslation();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const listed = pinned ? options.filter((option) => option !== pinned.value) : options;
  const shown = (needle ? listed.filter((option) => option.toLowerCase().includes(needle)) : listed).slice(0, 80);
  const typed = query.trim();
  const canUseTyped = typed.length > 0 && !options.some((option) => option.toLowerCase() === typed.toLowerCase());
  const showPinned =
    pinned != null &&
    pinned.value.length > 0 &&
    (!needle || pinned.label.toLowerCase().includes(needle) || pinned.value.toLowerCase().includes(needle));
  const buttonLabel = pinned && value === pinned.value ? pinned.label : value || emptyLabel;
  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) onOpen();
        else setQuery("");
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" size="sm" className="w-full justify-between px-2 font-normal">
          <span className={cn("min-w-0 truncate text-xs", value && value !== pinned?.value && "font-mono")}>
            {buttonLabel}
          </span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <div className="px-1.5 pb-1.5" onPointerDown={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("p4.filterField", { field: label })}
            className="h-7"
          />
        </div>
        <div className="max-h-64 overflow-auto">
          {!needle ? (
            <DropdownMenuItem onClick={() => onChange("")}>
              <span className="min-w-4">{value === "" ? <CheckIcon className="size-3.5" /> : null}</span>
              {emptyLabel}
            </DropdownMenuItem>
          ) : null}
          {showPinned && pinned ? (
            <DropdownMenuItem onClick={() => onChange(pinned.value)}>
              <span className="min-w-4">{value === pinned.value ? <CheckIcon className="size-3.5" /> : null}</span>
              {pinned.label}
            </DropdownMenuItem>
          ) : null}
          {shown.map((option) => (
            <DropdownMenuItem key={option} onClick={() => onChange(option)}>
              <span className="min-w-4">{option === value ? <CheckIcon className="size-3.5" /> : null}</span>
              <span className="truncate font-mono">{option}</span>
            </DropdownMenuItem>
          ))}
          {canUseTyped ? (
            <DropdownMenuItem onClick={() => onChange(typed)}>
              <span className="min-w-4" />
              <span className="truncate font-mono">{t("p4.useValue", { value: typed })}</span>
            </DropdownMenuItem>
          ) : null}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
