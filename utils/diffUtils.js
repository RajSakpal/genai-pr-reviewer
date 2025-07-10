export function splitDiffIntoHunks(diff) {
  const hunkRegex = /^@@.*?@@/gm;
  const lines = diff.split('\n');

  const hunks = [];
  let currentHunk = [];

  for (const line of lines) {
    if (line.match(hunkRegex)) {
      if (currentHunk.length) {
        hunks.push(currentHunk.join('\n'));
        currentHunk = [];
      }
    }
    currentHunk.push(line);
  }

  if (currentHunk.length) {
    hunks.push(currentHunk.join('\n'));
  }

  return hunks;
}
