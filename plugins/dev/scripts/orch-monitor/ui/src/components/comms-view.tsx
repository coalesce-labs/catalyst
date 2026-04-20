import { useEffect, useState } from "react";
import { useCommsChannels } from "@/hooks/use-comms";
import { CommsChannelsList } from "./comms-channels-list";
import { CommsChannelDetail } from "./comms-channel-detail";
import { EmptyState } from "./ui/empty-state";
import { MessageSquare } from "lucide-react";
import type { CommsFilter } from "@/lib/types";

interface CommsViewProps {
  initialFilter?: CommsFilter | null;
}

export function CommsView({ initialFilter }: CommsViewProps) {
  const { channels, status, retry } = useCommsChannels(true);
  const [selectedName, setSelectedName] = useState<string | null>(
    initialFilter?.channel ?? null,
  );
  const [filter, setFilter] = useState<CommsFilter>(
    initialFilter ?? { types: null, author: null, channel: null },
  );

  useEffect(() => {
    if (initialFilter?.channel) {
      setSelectedName(initialFilter.channel);
      setFilter({
        types: initialFilter.types ?? null,
        author: initialFilter.author ?? null,
        channel: initialFilter.channel,
      });
    }
  }, [initialFilter]);

  useEffect(() => {
    if (selectedName) return;
    if (channels.length === 0) return;
    setSelectedName(channels[0].name);
  }, [selectedName, channels]);

  return (
    <div className="flex h-[calc(100vh-140px)] gap-4">
      <div className="w-80 shrink-0">
        <CommsChannelsList
          channels={channels}
          status={status}
          selected={selectedName}
          onSelect={(n) => {
            setSelectedName(n);
            setFilter((f) => ({ ...f, channel: n }));
          }}
          onRetry={retry}
        />
      </div>
      <div className="min-w-0 flex-1">
        {selectedName ? (
          <CommsChannelDetail
            name={selectedName}
            filter={filter}
            onFilterChange={setFilter}
          />
        ) : (
          <EmptyState icon={MessageSquare} message="Select a channel" />
        )}
      </div>
    </div>
  );
}
