import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn("animate-shimmer rounded bg-surface-3", className)} />;
}

export function SkeletonKpiStrip() {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          className="flex items-start gap-3 rounded-lg border border-border bg-surface-2 px-4 py-3"
        >
          <Skeleton className="mt-0.5 h-4 w-4 rounded" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-3 w-16 rounded" />
            <Skeleton className="mt-1.5 h-6 w-20 rounded" />
            <Skeleton className="mt-1.5 h-3 w-24 rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}

export function SkeletonOrchestratorCard() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2 p-4">
      <div className="flex items-start justify-between">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <Skeleton className="h-3 w-3 rounded-full" />
            <Skeleton className="h-4 w-36 rounded" />
          </div>
          <Skeleton className="mt-2 h-3 w-28 rounded" />
        </div>
      </div>
      <Skeleton className="h-1.5 w-full rounded-full" />
      <div className="flex items-center gap-4">
        <Skeleton className="h-3 w-24 rounded" />
        <Skeleton className="h-3 w-16 rounded" />
        <Skeleton className="ml-auto h-3 w-12 rounded" />
      </div>
    </div>
  );
}

export function SkeletonDashboard() {
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-6 w-32 rounded" />

      <SkeletonKpiStrip />

      <div>
        <Skeleton className="mb-2 h-3 w-28 rounded" />
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <SkeletonOrchestratorCard key={i} />
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-lg border border-border bg-surface-2">
        <div className="border-b border-border px-4 py-2">
          <Skeleton className="h-3 w-14 rounded" />
        </div>
        <div className="flex flex-col gap-2 p-4">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full rounded" />
          ))}
        </div>
      </div>
    </div>
  );
}
