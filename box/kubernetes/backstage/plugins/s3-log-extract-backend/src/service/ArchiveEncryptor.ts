/// <reference path="./archiver-zip-encrypted.d.ts" />
import archiver from 'archiver';
import zipEncrypted from 'archiver-zip-encrypted';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// registerFormat throws if the same format is registered twice, so guard it
// at module level (the router calls encryptArchive once per extraction).
let formatRegistered = false;

function ensureFormatRegistered(): void {
  if (formatRegistered) return;
  archiver.registerFormat('zip-encrypted', zipEncrypted);
  formatRegistered = true;
}

/** Generate a strong random password for archive encryption (32 chars). */
export function generateArchivePassword(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * Wrap an extracted tar.gz into an AES-256 encrypted zip next to it, then
 * delete the plaintext source so only the encrypted archive remains on disk.
 * Decompression requires an AES-zip capable tool (7-Zip, Keka, p7zip).
 */
export async function encryptArchive(
  srcPath: string,
  password: string,
): Promise<{ zipPath: string; zipSize: number }> {
  ensureFormatRegistered();

  const zipPath = path.join(
    path.dirname(srcPath),
    `${path.basename(srcPath).replace(/\.tar\.gz$/, '')}.zip`,
  );

  const archive = archiver.create('zip-encrypted', {
    // The tar.gz payload is already compressed; store it as-is.
    zlib: { level: 0 },
    encryptionMethod: 'aes256',
    password,
  } as archiver.ArchiverOptions);
  const output = fs.createWriteStream(zipPath);

  await new Promise<void>((resolve, reject) => {
    output.on('close', () => resolve());
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    archive.file(srcPath, { name: path.basename(srcPath) });
    archive.finalize();
  });

  const zipSize = fs.statSync(zipPath).size;
  fs.unlinkSync(srcPath);

  return { zipPath, zipSize };
}
