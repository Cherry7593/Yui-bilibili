import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(`../web/${path}`, import.meta.url));
// The IHDR chunk follows the 8-byte signature: width, height (big-endian), bit depth, then colour type.
function png(file: string) {
  const data = read(`public/${file}`);
  assert.deepEqual([...data.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], `${file} is not a PNG`);
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), colourType: data[25], tRNS: data.includes('tRNS') };
}

test('every root-level image the page references is a square transparent PNG shipped from web/public', () => {
  // Vite copies web/public to the dist root as-is and never fails the build over a missing one.
  const source = `${read('index.html')}\n${read('main.tsx')}`;
  const files = new Set([...source.matchAll(/"\/([\w.-]+\.png)"/g)].map(match => match[1]));
  assert.ok(files.has('favicon.png') && files.has('logo.png'));
  for (const file of files) {
    const { width, height, colourType, tRNS } = png(file);
    // The sidebar draws the logo in a fixed square box on both themes, so it must be square and keep its transparency.
    assert.equal(width, height, `${file} is not square`);
    assert.ok(colourType === 6 || (colourType === 3 && tRNS), `${file} has no alpha`);
  }
});
