import { useState, type ReactNode } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface ChoiceOption<V extends string> { value: V; label: ReactNode; disabled?: boolean }

export function ChoiceSelect<V extends string>({value, options, onValueChange, disabled, placeholder, className, id, autoFocus, "aria-label": label}: {
  value: V;
  options: readonly ChoiceOption<V>[];
  onValueChange: (value: V) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  id?: string;
  autoFocus?: boolean;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const selected = options.find(option => option.value === value);
  return <DropdownMenu open={open} onOpenChange={setOpen}>
    <DropdownMenuTrigger asChild><Button id={id} type="button" autoFocus={autoFocus} variant="outline" disabled={disabled || !options.length} aria-label={label} onClick={event => {if (event.detail === 0) setOpen(current => !current);}} className={cn("h-8 w-full min-w-0 justify-between gap-2 px-2 text-xs font-normal", className)}><span className="min-w-0 truncate">{selected?.label ?? placeholder}</span><ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" /></Button></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="min-w-(--radix-dropdown-menu-trigger-width)">
      <DropdownMenuRadioGroup value={value} onValueChange={next => {const option = options.find(item => item.value === next); if (option && !option.disabled) onValueChange(option.value);}}>
        {options.map(option => <DropdownMenuRadioItem key={option.value} value={option.value} data-choice-value={option.value} disabled={option.disabled}>{option.label}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>;
}
