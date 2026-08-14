import fs from 'node:fs/promises';
import path from 'node:path';

const out = path.resolve('generated');
for (const name of ['page.txt', 'source-page.png']) {
  try {
    await fs.unlink(path.join(out, name));
    console.log(`Removed sensitive raw diagnostic: ${name}`);
  } catch (e) {
    if (e?.code !== 'ENOENT') throw e;
  }
}
