import AdmZip from "adm-zip";
import fs from "node:fs";
import path from "node:path";

const MAX_ENTRIES = 20000;
const MAX_UNCOMPRESSED_BYTES = 1024 * 1024 * 1024; // 1GB guard against zip bombs

/**
 * Extracts a zip buffer into destDir, rejecting entries that would escape
 * destDir (zip-slip) and enforcing basic size/entry-count limits.
 */
export function extractZip(zipPath, destDir) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  if (entries.length > MAX_ENTRIES) {
    throw Object.assign(new Error(`Zip has too many entries (${entries.length} > ${MAX_ENTRIES})`), { status: 400 });
  }

  const destRoot = path.resolve(destDir);
  fs.mkdirSync(destRoot, { recursive: true });

  let totalBytes = 0;
  let fileCount = 0;

  for (const entry of entries) {
    const targetPath = path.resolve(destRoot, entry.entryName);
    if (targetPath !== destRoot && !targetPath.startsWith(destRoot + path.sep)) {
      throw Object.assign(new Error(`Zip entry escapes target directory: ${entry.entryName}`), { status: 400 });
    }

    totalBytes += entry.header.size;
    if (totalBytes > MAX_UNCOMPRESSED_BYTES) {
      throw Object.assign(new Error("Zip exceeds maximum allowed uncompressed size"), { status: 400 });
    }

    if (entry.isDirectory) {
      fs.mkdirSync(targetPath, { recursive: true });
      continue;
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, entry.getData());
    fileCount++;
  }

  return { fileCount, destRoot };
}
