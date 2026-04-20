import { useState } from "react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

const TRIGGER_BTN =
  "inline-flex items-center rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm text-fg transition-colors hover:bg-surface-3";

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">
        {title}
      </h2>
      <div className="rounded-lg border border-border bg-surface-1 p-4">
        {children}
      </div>
    </section>
  );
}

export function Sandbox() {
  const [commandOpen, setCommandOpen] = useState(false);

  return (
    <TooltipProvider>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 p-6">
        <header className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold text-fg">
            shadcn/ui primitives sandbox
          </h1>
          <p className="text-sm text-muted">
            Smoke-check mount surface for interaction primitives introduced in
            CTL-97. Not a feature — toggle with <code>?dev=1</code>.
          </p>
        </header>

        <Section title="Separator">
          <div className="flex flex-col gap-2 text-sm text-fg">
            <span>Top</span>
            <Separator />
            <span>Bottom</span>
          </div>
        </Section>

        <Section title="Tooltip">
          <Tooltip>
            <TooltipTrigger className={TRIGGER_BTN}>
              Hover me
            </TooltipTrigger>
            <TooltipContent>Tooltip content</TooltipContent>
          </Tooltip>
        </Section>

        <Section title="Dialog">
          <Dialog>
            <DialogTrigger className={TRIGGER_BTN}>Open dialog</DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Example dialog</DialogTitle>
                <DialogDescription>
                  Modal content rendered through shadcn/ui Dialog.
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <button className={TRIGGER_BTN}>Confirm</button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </Section>

        <Section title="Sheet">
          <Sheet>
            <SheetTrigger className={TRIGGER_BTN}>
              Open sheet (right)
            </SheetTrigger>
            <SheetContent>
              <SheetHeader>
                <SheetTitle>Example sheet</SheetTitle>
                <SheetDescription>
                  Side-drawer rendered through shadcn/ui Sheet.
                </SheetDescription>
              </SheetHeader>
              <SheetFooter>
                <SheetClose className={TRIGGER_BTN}>Close</SheetClose>
              </SheetFooter>
            </SheetContent>
          </Sheet>
        </Section>

        <Section title="Tabs">
          <Tabs defaultValue="one">
            <TabsList>
              <TabsTrigger value="one">Tab one</TabsTrigger>
              <TabsTrigger value="two">Tab two</TabsTrigger>
            </TabsList>
            <TabsContent value="one">
              <p className="text-sm text-fg">Panel one content.</p>
            </TabsContent>
            <TabsContent value="two">
              <p className="text-sm text-fg">Panel two content.</p>
            </TabsContent>
          </Tabs>
        </Section>

        <Section title="DropdownMenu">
          <DropdownMenu>
            <DropdownMenuTrigger className={TRIGGER_BTN}>
              Open menu
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Actions</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem>Item one</DropdownMenuItem>
              <DropdownMenuItem>Item two</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Section>

        <Section title="ContextMenu">
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div className="flex h-16 cursor-default items-center justify-center rounded-md border border-dashed border-border text-sm text-muted">
                Right-click here
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem>Action one</ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem>Action two</ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        </Section>

        <Section title="Command">
          <button
            className={TRIGGER_BTN}
            onClick={() => setCommandOpen(true)}
          >
            Open command palette
          </button>
          <CommandDialog open={commandOpen} onOpenChange={setCommandOpen}>
            <CommandInput placeholder="Type to search…" />
            <CommandList>
              <CommandEmpty>No results.</CommandEmpty>
              <CommandGroup heading="Suggestions">
                <CommandItem>First command</CommandItem>
                <CommandItem>Second command</CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Settings">
                <CommandItem>Preferences</CommandItem>
              </CommandGroup>
            </CommandList>
          </CommandDialog>
          {/* Standalone Command (no dialog) to exercise the primitive directly. */}
          <div className="mt-3">
            <Command className="rounded-md border border-border bg-surface-2">
              <CommandInput placeholder="Inline palette…" />
              <CommandList>
                <CommandEmpty>No results.</CommandEmpty>
                <CommandGroup heading="Items">
                  <CommandItem>Inline item one</CommandItem>
                  <CommandItem>Inline item two</CommandItem>
                </CommandGroup>
              </CommandList>
            </Command>
          </div>
        </Section>

        <Section title="ScrollArea">
          <ScrollArea className="h-32 rounded-md border border-border bg-surface-2">
            <div className="flex flex-col gap-2 p-3 text-sm text-fg">
              {Array.from({ length: 20 }).map((_, i) => (
                <span key={i}>Row {i + 1}</span>
              ))}
            </div>
          </ScrollArea>
        </Section>
      </div>
    </TooltipProvider>
  );
}
