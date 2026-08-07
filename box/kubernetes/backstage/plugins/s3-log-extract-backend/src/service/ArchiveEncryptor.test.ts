import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as zlib from 'zlib';
import {
  encryptArchive,
  generateArchivePassword,
} from './ArchiveEncryptor';

describe('generateArchivePassword', () => {
  it('generates a 32-char url-safe password', () => {
    const password = generateArchivePassword();
    expect(password).toHaveLength(32);
    expect(password).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('generates unique passwords', () => {
    const a = generateArchivePassword();
    const b = generateArchivePassword();
    expect(a).not.toBe(b);
  });
});

describe('encryptArchive', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-encryptor-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function createTarGz(name: string): string {
    const srcPath = path.join(tempDir, name);
    fs.writeFileSync(srcPath, zlib.gzipSync(Buffer.from('log content')));
    return srcPath;
  }

  it('creates an encrypted zip and deletes the plaintext source', async () => {
    const srcPath = createTarGz('logs-prd-2026-03-05.tar.gz');

    const { zipPath, zipSize } = await encryptArchive(srcPath, 'secret');

    expect(zipPath).toBe(path.join(tempDir, 'logs-prd-2026-03-05.zip'));
    expect(fs.existsSync(zipPath)).toBe(true);
    expect(zipSize).toBeGreaterThan(0);
    expect(fs.statSync(zipPath).size).toBe(zipSize);
    // Plaintext archive must be gone after encryption.
    expect(fs.existsSync(srcPath)).toBe(false);
    // Zip magic bytes.
    const header = fs.readFileSync(zipPath).subarray(0, 2).toString('ascii');
    expect(header).toBe('PK');
  });

  it('produces different zip bytes for different passwords', async () => {
    const srcA = createTarGz('a.tar.gz');
    const srcB = createTarGz('b.tar.gz');

    const a = await encryptArchive(srcA, 'password-a');
    const b = await encryptArchive(srcB, 'password-b');

    const bytesA = fs.readFileSync(a.zipPath);
    const bytesB = fs.readFileSync(b.zipPath);
    expect(bytesA.equals(bytesB)).toBe(false);
  });
});
