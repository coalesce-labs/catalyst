// icon-picker-popover.tsx — searchable glyph+favicon picker for Project Settings (CTL-1208, CTL-1226, CTL-1233, CTL-1249).
// CTL-1249: the searchable name index is a committed static array, so the All-icons grid renders
// instantly (no chunk gate) and full-library search is zero-network; per-glyph chunks load only for
// the visible virtualized cells. The All-icons body branches via the pure resolveAllIconsViewState
// state machine (error/no-matches/results) — never an indefinite "Loading icons…".
// CTL-1233: virtualizes the All-icons grid with @tanstack/react-virtual to eliminate typing lag.
// Featured grid remains cmdk CommandItem-based (small, keyboard-navigable). All-icons uses plain
// buttons (GlyphGridButton) to avoid cmdk item-registration overhead on mount/unmount.
import { useState, useMemo, useRef, useCallback } from "react";
import { ChevronDownIcon } from "lucide-react";
import { useDebounce } from "@uidotdev/usehooks";
import { useVirtualizer } from "@tanstack/react-virtual";
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
import { enumeratePhosphorGlyphNames, useManifestLoadFailed } from "@/lib/phosphor-icons";
import {
  buildBasePickerItems,
  buildAllGlyphItems,
  filterPickerItems,
  resolveActiveIconLabel,
  resolveAllIconsViewState,
  GLYPH_GRID_SCROLL_CLASS,
  GLYPH_GRID_SCROLL_STYLE,
} from "./icon-picker-model";
import type { IconPickerItem } from "./icon-picker-model";
import type { IconCandidate } from "@/lib/repo-icons";

const GRID_COLS = 8;
const ROW_PX = 36;

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

function GlyphGridButton({
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
    <button
      type="button"
      role="option"
      aria-selected={currentValue === item.value}
      aria-label={item.label}
      title={item.label}
      onClick={onSelect}
      className="p-0.5 h-8 w-8 flex items-center justify-center rounded-sm hover:bg-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-ring flex-none"
      data-active={currentValue === item.value ? true : undefined}
    >
      <ProjectMarkIcon mark={{ kind: "glyph", name: item.name! }} color={accentColor} size={18} />
    </button>
  );
}

function VirtualGlyphGrid({
  items,
  accentColor,
  currentValue,
  onSelect,
}: {
  items: IconPickerItem[];
  accentColor: string;
  currentValue: string | null;
  onSelect: (value: string | null) => void;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const rowCount = Math.ceil(items.length / GRID_COLS);

  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_PX,
    overscan: 4,
  });

  return (
    <div
      ref={parentRef}
      className={GLYPH_GRID_SCROLL_CLASS}
      style={GLYPH_GRID_SCROLL_STYLE}
    >
      <div
        style={{
          height: `${rowVirtualizer.getTotalSize()}px`,
          width: "100%",
          position: "relative",
        }}
      >
        {rowVirtualizer.getVirtualItems().map((virtualRow) => {
          const startIdx = virtualRow.index * GRID_COLS;
          const rowItems = items.slice(startIdx, startIdx + GRID_COLS);
          return (
            <div
              key={virtualRow.key}
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                height: `${virtualRow.size}px`,
                transform: `translateY(${virtualRow.start}px)`,
              }}
              className="flex gap-1 p-0.5"
            >
              {rowItems.map((item) => (
                <GlyphGridButton
                  key={item.value}
                  item={item}
                  currentValue={currentValue}
                  accentColor={accentColor}
                  onSelect={() => onSelect(item.value)}
                />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function IconPickerPopover({ value, onChange, candidates, hue }: IconPickerPopoverProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebounce(query, 80);

  const handleOpenChange = useCallback((next: boolean) => {
    setOpen(next);
  }, []);

  const accentColor = (hue && NAMED_COLORS[hue]?.text) || "currentColor";
  const triggerLabel = resolveActiveIconLabel(value);
  // CTL-1370: true when the per-glyph importer manifest is in a failed-load state. A redeploy that
  // re-hashes the manifest chunk strands the running bundle on a 404 URL no in-app retry can recover
  // — so we surface a user-triggered reload (the reliable recovery; no auto-reload, no loop risk).
  const manifestFailed = useManifestLoadFailed();

  // Base items (Auto + favicons + featured) — memoized on candidates (stable ref).
  const baseItems = useMemo(() => buildBasePickerItems(candidates), [candidates]);

  // All non-featured items — built eagerly from the committed static index (no chunk gate).
  const allGlyphItems = useMemo(() => buildAllGlyphItems(enumeratePhosphorGlyphNames()), []);

  // Filtered views.
  const filteredBase = useMemo(
    () => filterPickerItems(baseItems, debouncedQuery),
    [baseItems, debouncedQuery],
  );
  const filteredAll = useMemo(
    () => filterPickerItems(allGlyphItems, debouncedQuery),
    [allGlyphItems, debouncedQuery],
  );

  const featuredGlyphs = filteredBase.filter((i) => i.group === "glyph" && i.featured);
  const filteredFavicons = filteredBase.filter((i) => i.group === "favicon");
  const showAuto = filteredBase.some((i) => i.group === "auto");

  const hasResults = showAuto || filteredFavicons.length > 0 || featuredGlyphs.length > 0 || filteredAll.length > 0;

  const handleSelect = useCallback((next: string | null) => {
    onChange(next);
    setOpen(false);
  }, [onChange]);

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
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
        <Command shouldFilter={false}>
          <CommandInput
            placeholder="Search icons…"
            className="h-9 text-xs"
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-none">
            {!hasResults && (
              <CommandEmpty className="py-4 text-center text-xs text-muted">
                No icons found.
              </CommandEmpty>
            )}

            {/* Auto group */}
            {showAuto && (
              <CommandGroup heading="Auto">
                <CommandItem
                  key="auto"
                  value="auto"
                  onSelect={() => handleSelect(null)}
                  className="text-xs gap-2"
                  data-active={value === null ? true : undefined}
                >
                  <span className="size-3.5 rounded-sm border border-border bg-s2 flex-shrink-0" />
                  Auto (best detected)
                </CommandItem>
              </CommandGroup>
            )}

            {/* Detected favicon group */}
            {filteredFavicons.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Detected">
                  {filteredFavicons.map((item) => (
                    <CommandItem
                      key={item.value}
                      value={`detected ${item.searchKey}`}
                      onSelect={() => handleSelect(item.value)}
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

            {/* Featured glyph grid — small, keyboard-navigable via cmdk */}
            {featuredGlyphs.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Featured">
                  <div className="grid grid-cols-8 gap-1 p-1">
                    {featuredGlyphs.map((item) => (
                      <GlyphGridCell
                        key={item.value}
                        item={item}
                        currentValue={value}
                        accentColor={accentColor}
                        onSelect={() => handleSelect(item.value)}
                      />
                    ))}
                  </div>
                </CommandGroup>
              </>
            )}

            {/* All icons — virtualized; plain buttons (not cmdk items) */}
            <CommandSeparator />
            <CommandGroup heading="All icons">
              {manifestFailed && (
                <div
                  role="status"
                  className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs text-muted"
                >
                  <span>Some icons couldn&apos;t load.</span>
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    title="Reload the page to fetch the latest icon assets"
                    className="rounded-sm px-1.5 py-0.5 font-medium text-foreground hover:bg-accent focus:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  >
                    Reload
                  </button>
                </div>
              )}
              {(() => {
                const state = resolveAllIconsViewState({
                  namesEmpty: enumeratePhosphorGlyphNames().length === 0,
                  queryActive: Boolean(debouncedQuery.trim()),
                  filteredCount: filteredAll.length,
                });
                if (state === "error")
                  return (
                    <p role="alert" className="py-4 text-center text-xs text-muted">
                      Couldn&apos;t load icons.
                    </p>
                  );
                if (state === "no-matches")
                  return <p className="py-2 text-center text-xs text-muted">No matching icons.</p>;
                return (
                  <VirtualGlyphGrid
                    items={filteredAll}
                    accentColor={accentColor}
                    currentValue={value}
                    onSelect={handleSelect}
                  />
                );
              })()}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
