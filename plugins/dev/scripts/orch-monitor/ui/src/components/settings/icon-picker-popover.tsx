// icon-picker-popover.tsx — searchable glyph+favicon picker for Project Settings (CTL-1208).
// Popover + shadcn Command (cmdk): Auto | Detected favicons | Curated Phosphor set.
import { useState } from "react";
import { ChevronDownIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { NAMED_COLORS } from "@/lib/color-palette";
import { ProjectMarkIcon } from "@/components/project-mark-icon";
import { buildIconPickerItems, resolveActiveIconLabel } from "./icon-picker-model";
import type { IconCandidate } from "@/lib/repo-icons";

interface IconPickerPopoverProps {
  /** Current server icon value: null = Auto, path = favicon, "phosphor:<n>" = glyph. */
  value: string | null;
  onChange: (next: string | null) => void;
  /** Detected favicon candidates for this project's repo. */
  candidates: IconCandidate[];
  /** Current project hue name (e.g. "blue") for glyph preview tinting. */
  hue: string | null;
}

export function IconPickerPopover({ value, onChange, candidates, hue }: IconPickerPopoverProps) {
  const [open, setOpen] = useState(false);

  const items = buildIconPickerItems(candidates);
  const accentColor = (hue && NAMED_COLORS[hue]?.text) || "currentColor";
  const triggerLabel = resolveActiveIconLabel(value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="w-48 justify-between font-normal text-xs"
          aria-label="Choose project icon"
        >
          <span className="flex items-center gap-2 truncate">
            {value ? (
              <ProjectMarkIcon
                mark={
                  value.startsWith("phosphor:")
                    ? { kind: "glyph", name: value.slice("phosphor:".length) }
                    : { kind: "favicon", dataUrl: candidates.find((c) => c.path === value)?.dataUrl ?? "", selectedPath: value }
                }
                color={accentColor}
                size={14}
              />
            ) : null}
            <span className="truncate">{triggerLabel}</span>
          </span>
          <ChevronDownIcon className="size-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-0"
        align="start"
        onPointerDownOutside={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
      >
        <Command>
          <CommandInput placeholder="Search icons…" className="h-9 text-xs" />
          <CommandList className="max-h-72">
            <CommandEmpty className="py-4 text-center text-xs text-muted">
              No icons found.
            </CommandEmpty>

            {/* Auto group */}
            <CommandGroup heading="Auto">
              <CommandItem
                key="auto"
                value="auto"
                onSelect={() => { onChange(null); setOpen(false); }}
                className="text-xs gap-2"
                data-active={value === null ? true : undefined}
              >
                <span className="size-3.5 rounded-sm border border-border bg-s2 flex-shrink-0" />
                Auto (best detected)
              </CommandItem>
            </CommandGroup>

            {/* Detected favicon group */}
            {candidates.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Detected">
                  {items
                    .filter((i) => i.group === "favicon")
                    .map((item) => (
                      <CommandItem
                        key={item.value}
                        value={`detected ${item.searchKey}`}
                        onSelect={() => { onChange(item.value); setOpen(false); }}
                        className="text-xs gap-2"
                        data-active={value === item.value ? true : undefined}
                      >
                        {item.dataUrl && (
                          <ProjectMarkIcon
                            mark={{ kind: "favicon", dataUrl: item.dataUrl, selectedPath: item.value ?? "" }}
                            color={accentColor}
                            size={14}
                          />
                        )}
                        <span className="truncate">{item.label}</span>
                      </CommandItem>
                    ))}
                </CommandGroup>
              </>
            )}

            {/* Curated glyph set */}
            <CommandSeparator />
            <CommandGroup heading="Icons">
              {items
                .filter((i) => i.group === "glyph")
                .map((item) => (
                  <CommandItem
                    key={item.value}
                    value={`glyph ${item.searchKey}`}
                    onSelect={() => { onChange(item.value); setOpen(false); }}
                    className="text-xs gap-2"
                    data-active={value === item.value ? true : undefined}
                  >
                    <ProjectMarkIcon
                      mark={{ kind: "glyph", name: item.name! }}
                      color={accentColor}
                      size={14}
                    />
                    <span className="truncate">{item.label}</span>
                  </CommandItem>
                ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
