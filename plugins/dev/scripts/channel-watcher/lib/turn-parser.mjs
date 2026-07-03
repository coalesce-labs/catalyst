// turn-parser.mjs — CTL-1423. Pure turn-header counting for md-channel files.
// md-channel turn headers have the exact shape: `### NN | FROM: … | TO: … | …`
// (the `### NN |` prefix is the discriminator; prose ### headings never have ` |`).

const TURN_RE = /^### (\d+) \|/m;
const TURN_RE_GLOBAL = /^### (\d+) \|/gm;

/** Count the number of turn headers in an md-channel file's content. */
export function countTurns(md) {
  const matches = md.match(TURN_RE_GLOBAL);
  return matches ? matches.length : 0;
}

/** Return the sequence number of the latest turn header (0 if none). */
export function latestTurn(md) {
  let latest = 0;
  let m;
  const re = new RegExp(TURN_RE_GLOBAL.source, "gm");
  while ((m = re.exec(md)) !== null) {
    const n = parseInt(m[1], 10);
    if (n > latest) latest = n;
  }
  return latest;
}
