// account-banner.tsx — CTL-1653. The LOUD, conditional banner that appears when
// this node's ACTIVE Claude account's binding window is `rejected` (exhausted).
// Structural clone of ui/otel-health-banner.tsx: returns null unless bannerModel()
// is non-null; when shown, a red `role="alert"` div names the reset time and a
// sibling account with headroom. It clears automatically once the SSE next reports
// `ok` (the window reset or the account was switched) — no reload.
//
// error ≠ rejected: a transport `error` posture is the sensor being broken, NOT the
// account being exhausted, so bannerModel() returns null for it and this stays quiet.

import { cn } from "@/lib/utils";
import { AlertCircle } from "lucide-react";
import { useAccountSignalContext } from "@/hooks/use-account-signal";
import { bannerModel } from "@/hooks/account-signal-lib";

/** Local, human-readable reset time; passes the raw string through if unparseable. */
function fmtReset(resetsAt: string | null): string {
  if (!resetsAt) return "an unknown time";
  const ms = Date.parse(resetsAt);
  if (!Number.isFinite(ms)) return resetsAt;
  return new Date(ms).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function AccountBanner({ className }: { className?: string }) {
  const account = useAccountSignalContext();
  const model = bannerModel(account);
  if (!model) return null;

  const who = model.handle ?? "the active account";

  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2 rounded-lg border border-red/20 bg-red/10 px-4 py-2 text-[13px] text-red",
        className,
      )}
    >
      <AlertCircle className="mt-[2px] h-4 w-4 shrink-0" />
      <div className="min-w-0">
        <span>
          Claude account <span className="font-medium">{who}</span> is out of budget — resets{" "}
          {fmtReset(model.resetsAt)}.
          {model.sibling ? (
            <>
              {" "}
              Switch to <span className="font-medium">{model.sibling.label}</span> (has headroom).
            </>
          ) : null}
        </span>
      </div>
    </div>
  );
}
