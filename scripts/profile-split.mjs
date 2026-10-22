// Splits LibriSpeech speakers before any accuracy is measured.
// The 12 lowest and 12 highest F0 speakers of each label are alternated
// between calibration and test, so both sides include pitch tails.
// Everyone else is calibration when the speaker id mod 3 is 0, and test
// otherwise. Weights in drive-coach.js were fit on calibration only.

export function assignProfileSplit(rows) {
  const test = new Set();
  const calibrate = new Set();
  for (const label of ['feminine', 'masculine']) {
    const group = rows.filter(row => row.label === label && Number.isFinite(row.hz)).sort((a, b) => a.hz - b.hz);
    const tails = new Set([...group.slice(0, 12), ...group.slice(-12)].map(row => row.id));
    let tailIndex = 0;
    for (const row of group) {
      const bucket = tails.has(row.id)
        ? (tailIndex++ % 2 === 0 ? test : calibrate)
        : (Number(row.id) % 3 === 0 ? calibrate : test);
      bucket.add(row.id);
    }
  }
  return { test, calibrate };
}
