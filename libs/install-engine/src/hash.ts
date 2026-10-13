/**
 * Content hash of a placed file or directory, as the installer records it in the ledger
 * (`appliedHash`) and as `diff` re-computes it. One definition, so the two can never diverge:
 * a directory hashes its sorted entries recursively; a file hashes its bytes. Both return
 * `sha256:<hex>`.
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export function hashPathForInstall(p: string): string {
  if (!fs.existsSync(p)) return '';
  const stat = fs.statSync(p);
  if (stat.isDirectory()) return hashDirForInstall(p);
  const data = fs.readFileSync(p);
  return 'sha256:' + crypto.createHash('sha256').update(data).digest('hex');
}

function hashDirForInstall(dirPath: string): string {
  const h = crypto.createHash('sha256');
  const entries = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const child = path.join(dirPath, entry.name);
    h.update(entry.name + ':');
    if (entry.isDirectory()) {
      h.update('dir:' + hashDirForInstall(child));
    } else {
      const data = fs.readFileSync(child);
      h.update('file:sha256:' + crypto.createHash('sha256').update(data).digest('hex'));
    }
  }
  return 'sha256:' + h.digest('hex');
}
