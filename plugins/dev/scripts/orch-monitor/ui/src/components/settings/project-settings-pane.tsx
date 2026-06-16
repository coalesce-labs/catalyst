// project-settings-pane.tsx — per-project editor pane (CTL-1153 Phase 5).
//
// Split into a pure renderer (ProjectSettingsPaneContent — tree-walk testable)
// and a stateful wrapper (ProjectSettingsPane — the public component).
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { NAMED_COLORS } from "@/lib/color-palette";
import { NAMED_COLOR_NAMES } from "@/lib/repo-color-picks-store";
import { STATE_MAP_KEYS, STATE_MAP_KEY_LABEL, diffStateMap } from "@/lib/project-settings-model";
import { putProject } from "@/lib/put-project";
import type { ProjectDescriptor } from "@/hooks/use-projects";

type ProjectInput = Pick<
  ProjectDescriptor,
  "key" | "name" | "repo" | "defaultColor" | "storedName" | "storedColor" | "stateMap"
>;

// ── Pure content renderer (all state passed as props; tree-walk testable) ─────

export interface ProjectSettingsPaneContentProps {
  project: ProjectInput;
  name: string;
  color: string;
  stateMapEdits: Record<string, string>;
  saving: boolean;
  error: string | null;
  onNameChange: (v: string) => void;
  onColorChange: (v: string) => void;
  onStateMapChange: (key: string, value: string) => void;
  onSave: () => void;
}

export function ProjectSettingsPaneContent({
  project, name, color, stateMapEdits, saving, error,
  onNameChange, onColorChange, onStateMapChange, onSave,
}: ProjectSettingsPaneContentProps) {
  return (
    <div className="flex flex-1 flex-col gap-6 min-w-0">
      <header>
        <h2 className="text-base font-semibold text-fg">{project.name}</h2>
        <p className="text-xs text-muted">{project.key}</p>
      </header>

      {error && (
        <p className="rounded-md bg-red/10 px-3 py-2 text-xs text-red">{error}</p>
      )}

      {/* ── Display name ─────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-2">
        <label className="text-sm font-medium text-fg" htmlFor={`psp-name-${project.key}`}>
          Display name
        </label>
        <Input
          id={`psp-name-${project.key}`}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={project.name}
          className="max-w-xs"
        />
        <p className="text-xs text-muted">
          Leave blank to use the configured default ({project.name}).
        </p>
      </section>

      {/* ── Color ─────────────────────────────────────────────────────────── */}
      <section className="flex flex-col gap-2">
        <p className="text-sm font-medium text-fg">Color</p>
        <ToggleGroup
          type="single"
          value={color}
          onValueChange={(v) => { if (v) onColorChange(v); }}
          variant="outline"
          size="sm"
          className="flex-wrap justify-start"
        >
          <ToggleGroupItem
            value="auto"
            className={cn("text-xs", color === "auto" ? "text-fg" : "text-muted")}
            title="Auto (inherit configured default)"
          >
            Auto
          </ToggleGroupItem>
          {NAMED_COLOR_NAMES.map((hue) => (
            <ToggleGroupItem
              key={hue}
              value={hue}
              title={hue}
              className={cn("gap-1 text-xs", color === hue ? "text-fg" : "text-muted")}
            >
              <span
                aria-hidden
                className="size-3 rounded-full"
                style={{
                  background: NAMED_COLORS[hue]?.bg,
                  outline: "1px solid var(--border-subtle)",
                }}
              />
              {hue}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </section>

      {/* ── Linear stateMap ──────────────────────────────────────────────── */}
      <section className="flex flex-col gap-2">
        <p className="text-sm font-medium text-fg">Linear state names</p>
        <p className="text-xs text-muted">
          Override how each pipeline transition is named in your Linear workspace. Leave blank to
          inherit the global default.
        </p>
        <div className="flex flex-col divide-y divide-border">
          {STATE_MAP_KEYS.map((k) => (
            <div key={k} className="flex items-center gap-4 py-2">
              <span className="w-32 shrink-0 text-xs text-muted">
                {STATE_MAP_KEY_LABEL[k]}
              </span>
              <Input
                value={stateMapEdits[k] ?? ""}
                onChange={(e) => onStateMapChange(k, e.target.value)}
                placeholder="(global default)"
                className="max-w-xs text-xs"
              />
            </div>
          ))}
        </div>
      </section>

      <div className="flex items-center gap-3">
        <Button onClick={onSave} disabled={saving} size="sm">
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </div>
  );
}

// ── Pure patch builder (exported for unit tests) ──────────────────────────────

export function buildProjectPatch(
  project: ProjectInput,
  edits: { name: string; color: string; stateMapEdits: Record<string, string> },
): Parameters<typeof putProject>[1] {
  const patch: Parameters<typeof putProject>[1] = {};
  if (edits.name !== (project.storedName ?? "")) patch.name = edits.name || null;
  if (edits.color !== (project.storedColor ?? "auto")) {
    patch.color = edits.color === "auto" ? null : edits.color;
  }
  const mapDiff = diffStateMap(project.stateMap, edits.stateMapEdits);
  if (Object.keys(mapDiff).length > 0) patch.stateMap = mapDiff;
  return patch;
}

// ── Stateful wrapper (public component) ───────────────────────────────────────

interface ProjectSettingsPaneProps {
  project: ProjectInput;
  /** Called after a successful save so the caller can refetch the roster. */
  onSaved: () => void | Promise<void>;
}

export function ProjectSettingsPane({ project, onSaved }: ProjectSettingsPaneProps) {
  const [name, setName] = useState(project.storedName ?? "");
  const [color, setColor] = useState<string>(project.storedColor ?? "auto");
  const [stateMapEdits, setStateMapEdits] = useState<Record<string, string>>(
    () => Object.fromEntries(STATE_MAP_KEYS.map((k) => [k, project.stateMap?.[k] ?? ""])),
  );

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const patch = buildProjectPatch(project, { name, color, stateMapEdits });
      await putProject(project.key, patch);
      await onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ProjectSettingsPaneContent
      project={project}
      name={name}
      color={color}
      stateMapEdits={stateMapEdits}
      saving={saving}
      error={error}
      onNameChange={setName}
      onColorChange={setColor}
      onStateMapChange={(k, v) => setStateMapEdits((prev) => ({ ...prev, [k]: v }))}
      onSave={handleSave}
    />
  );
}
