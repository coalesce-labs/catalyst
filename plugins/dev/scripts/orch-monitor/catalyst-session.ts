#!/usr/bin/env bun
import {
  openDb,
  closeDb,
  setDisplayName,
  addFlag,
  removeFlag,
  addNote,
  addTag,
  removeTag,
  deleteAnnotation,
  getAnnotation,
  getAllAnnotations,
} from "./lib/annotations";

const VALID_FLAGS = new Set(["starred", "flagged", "archived"]);

const CATALYST_DIR =
  process.env.CATALYST_DIR ?? `${process.env.HOME}/catalyst`;

function usage(): never {
  console.error(
    `Usage: catalyst-session <command> [options]

Commands:
  annotate <session-id>  Add/modify annotations for a session
  list                   List all annotated sessions

annotate options:
  --name <text>          Set display name
  --flag <flag>          Add flag (starred, flagged, archived)
  --unflag <flag>        Remove flag
  --note <text>          Add a note
  --tag <tag>            Add tag (repeatable)
  --untag <tag>          Remove tag
  --clear                Remove all annotations for this session`,
  );
  process.exit(1);
}

function parseAnnotateArgs(args: string[]): {
  sessionId: string;
  name?: string | null;
  flags: string[];
  unflags: string[];
  notes: string[];
  tags: string[];
  untags: string[];
  clear: boolean;
} {
  if (args.length === 0) {
    console.error("Error: annotate requires a session-id argument");
    process.exit(1);
  }

  const sessionId = args[0];
  const flags: string[] = [];
  const unflags: string[] = [];
  const notes: string[] = [];
  const tags: string[] = [];
  const untags: string[] = [];
  let name: string | null | undefined;
  let clear = false;

  function requireValue(opt: string, i: number): string {
    const val = args[i];
    if (val === undefined) {
      console.error(`Error: ${opt} requires a value`);
      process.exit(1);
    }
    return val;
  }

  let i = 1;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "--name":
        name = args[++i] ?? null;
        break;
      case "--flag": {
        const val = requireValue("--flag", ++i);
        if (!VALID_FLAGS.has(val)) {
          console.error(
            `Error: invalid flag "${val}". Valid: starred, flagged, archived`,
          );
          process.exit(1);
        }
        flags.push(val);
        break;
      }
      case "--unflag":
        unflags.push(requireValue("--unflag", ++i));
        break;
      case "--note":
        notes.push(requireValue("--note", ++i));
        break;
      case "--tag":
        tags.push(requireValue("--tag", ++i));
        break;
      case "--untag":
        untags.push(requireValue("--untag", ++i));
        break;
      case "--clear":
        clear = true;
        break;
      default:
        console.error(`Unknown option: ${arg}`);
        process.exit(1);
    }
    i++;
  }

  const hasAction =
    name !== undefined ||
    flags.length > 0 ||
    unflags.length > 0 ||
    notes.length > 0 ||
    tags.length > 0 ||
    untags.length > 0 ||
    clear;

  if (!hasAction) {
    console.error("Error: annotate requires at least one option");
    process.exit(1);
  }

  return { sessionId, name, flags, unflags, notes, tags, untags, clear };
}

function cmdAnnotate(args: string[]): void {
  const parsed = parseAnnotateArgs(args);
  const dbPath = `${CATALYST_DIR}/annotations.db`;
  openDb(dbPath);

  try {
    if (parsed.clear) {
      deleteAnnotation(parsed.sessionId);
      console.info(`Cleared annotations for ${parsed.sessionId}`);
      return;
    }

    if (parsed.name !== undefined) {
      setDisplayName(parsed.sessionId, parsed.name);
    }
    for (const f of parsed.flags) addFlag(parsed.sessionId, f);
    for (const f of parsed.unflags) removeFlag(parsed.sessionId, f);
    for (const n of parsed.notes) addNote(parsed.sessionId, n);
    for (const t of parsed.tags) addTag(parsed.sessionId, t);
    for (const t of parsed.untags) removeTag(parsed.sessionId, t);

    const ann = getAnnotation(parsed.sessionId);
    if (ann) {
      console.info(JSON.stringify(ann, null, 2));
    }
  } finally {
    closeDb();
  }
}

function cmdList(): void {
  const dbPath = `${CATALYST_DIR}/annotations.db`;
  openDb(dbPath);
  try {
    const all = getAllAnnotations();
    console.info(JSON.stringify(all, null, 2));
  } finally {
    closeDb();
  }
}

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "annotate":
    cmdAnnotate(rest);
    break;
  case "list":
    cmdList();
    break;
  default:
    usage();
}
