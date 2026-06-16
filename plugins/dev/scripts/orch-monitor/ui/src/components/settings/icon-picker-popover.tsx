// icon-picker-popover.tsx — searchable glyph+favicon picker for Project Settings (CTL-1208, CTL-1226).
// Popover + shadcn Command (cmdk): Auto | Detected favicons | Featured grid | All icons grid.
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
import type { IconPickerItem } from "./icon-picker-model";
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

function GlyphGridCell({
  item,
  currentValue,
  accentColor,
  onSelect,
}: {
  item: IconPickerItem;
  currentValue: string | null;
  accentColor: string;
  onSelect: () => void;
}) {
  return (
    <CommandItem
      value={`glyph ${item.searchKey}`}
      onSelect={onSelect}
      className="p-0.5 h-8 w-8 justify-center flex-none"
      data-active={currentValue === item.value ? true : undefined}
      aria-label={item.label}
      title={item.label}
    >
      <ProjectMarkIcon mark={{ kind: "glyph", name: item.name! }} color={accentColor} size={18} />
    </CommandItem>
  );
}

export function IconPickerPopover({ value, onChange, candidates, hue }: IconPickerPopoverProps) {
  const [open, setOpen] = useState(false);

  const items = buildIconPickerItems(candidates);
  const accentColor = (hue && NAMED_COLORS[hue]?.text) || "currentColor";
  const triggerLabel = resolveActiveIconLabel(value);

  const featuredGlyphs = items.filter((i) => i.group === "glyph" && i.featured);
  const allGlyphs = items.filter((i) => i.group === "glyph" && !i.featured);

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
      {/* CTL-1226 grid width + CTL-1225 dismiss guards so the first click on
          Save (outside the popover) isn't swallowed by Radix DismissableLayer. */}
      <PopoverContent
        className="w-80 p-0"
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

            {/* Featured glyph grid */}
            <CommandSeparator />
            <CommandGroup heading="Featured">
              <div className="grid grid-cols-8 gap-1 p-1">
                {featuredGlyphs.map((item) => (
                  <GlyphGridCell
                    key={item.value}
                    item={item}
                    currentValue={value}
                    accentColor={accentColor}
                    onSelect={() => { onChange(item.value); setOpen(false); }}
                  />
                ))}
              </div>
            </CommandGroup>

            {/* All icons glyph grid */}
            <CommandSeparator />
            <CommandGroup heading="All icons">
              <div className="grid grid-cols-8 gap-1 p-1">
                {allGlyphs.map((item) => (
                  <GlyphGridCell
                    key={item.value}
                    item={item}
                    currentValue={value}
                    accentColor={accentColor}
                    onSelect={() => { onChange(item.value); setOpen(false); }}
                  />
                ))}
              </div>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
