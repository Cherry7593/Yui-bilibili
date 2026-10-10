// Only these public source files are fetched. Never download the credential backup.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
const commit = '1521d19d4118bfe23e08ec4c7702991c5f9de0ba';
const files = {
  'mcp_server.py': '5b13f8f9c5ef0bf494dbdc03c5c1b985df22eeca',
  'LICENSE': 'cf19c3e4ea3787a0bb5fef9abfd714e72244b35c',
  'bili_login.py': 'c33bebcd1e9c04308617b9eefd75df68462dd4ca',
};
await mkdir('vendor/bilibili-mcp', { recursive: true });
for (const [name, expected] of Object.entries(files)) {
  const response = await fetch(`https://raw.githubusercontent.com/adoresever/bilibili-mcp/${commit}/${name}`);
  if (!response.ok) throw new Error(`Source download failed: ${name}`);
  const data = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
  if (hash !== expected) throw new Error(`Upstream blob mismatch: ${name}`);
  await writeFile(`vendor/bilibili-mcp/${name}`, data);
  console.log(`${name}: pinned blob verified`);
}
