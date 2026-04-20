import { useMemo, type ReactNode } from "react";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "./ui/sheet";
import { renderBriefingHtml } from "@/lib/briefings";

interface BriefingSheetProps {
  wave: number;
  markdown: string;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function BriefingSheet({
  wave,
  markdown,
  children,
  open,
  onOpenChange,
}: BriefingSheetProps) {
  const html = useMemo(() => renderBriefingHtml(markdown), [markdown]);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetTrigger asChild>{children}</SheetTrigger>
      <SheetContent
        side="right"
        className="w-full overflow-y-auto sm:max-w-[560px]"
      >
        <SheetHeader>
          <SheetTitle>Wave {wave} briefing</SheetTitle>
        </SheetHeader>
        <div
          className="md-content px-4 pb-4"
          dangerouslySetInnerHTML={{ __html: html }}
        />
      </SheetContent>
    </Sheet>
  );
}
