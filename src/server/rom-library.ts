import { lstat, open, readdir, realpath } from "node:fs/promises";
import { extname, basename, dirname, join, resolve } from "node:path";

export const MAX_ROM_BYTES = 8 * 1024 * 1024;
const extensions = new Set([".gb", ".gbc"]);

export interface LocalRomEntry {
  readonly id: string;
  readonly name: string;
  readonly byteLength: number;
}

/** Local cartridge catalog. The browser receives filenames, never bytes or absolute paths. */
export class LocalRomLibrary {
  private readonly directory: string;

  constructor(directory: string) { this.directory = resolve(directory); }

  private validName(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 255 &&
      !/[\\/:\x00-\x1f]/.test(value) && basename(value) === value && extensions.has(extname(value).toLowerCase());
  }

  async list(): Promise<readonly LocalRomEntry[]> {
    let entries;
    try { entries = await readdir(this.directory, { withFileTypes: true }); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new Error("Could not read the local ROM folder.");
    }
    const names = entries.filter((entry) => entry.isFile() && this.validName(entry.name))
      .map((entry) => entry.name).sort((left, right) => left.localeCompare(right, "en")).slice(0, 256);
    const result: LocalRomEntry[] = [];
    for (const name of names) {
      try {
        const file = await lstat(join(this.directory, name));
        if (file.isFile() && file.size > 0 && file.size <= MAX_ROM_BYTES) result.push({ id: name, name, byteLength: file.size });
      } catch { /* A cartridge removed during listing is simply unavailable. */ }
    }
    return result;
  }

  async read(id: unknown): Promise<Uint8Array> {
    if (!this.validName(id)) throw new Error("Choose a ROM from the local library.");
    try {
      const root = await realpath(this.directory);
      const path = join(root, id);
      const file = await lstat(path);
      if (!file.isFile() || dirname(await realpath(path)) !== root || file.size < 1 || file.size > MAX_ROM_BYTES) {
        throw new Error("Unavailable ROM.");
      }
      const handle = await open(path, "r");
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size < 1 || info.size > MAX_ROM_BYTES) throw new Error("Unavailable ROM.");
        // Read a bounded amount even if another process appends to the file.
        const bytes = Buffer.alloc(info.size);
        let position = 0;
        while (position < bytes.length) {
          const { bytesRead } = await handle.read(bytes, position, bytes.length - position, position);
          if (!bytesRead) throw new Error("Unavailable ROM.");
          position += bytesRead;
        }
        if ((await handle.stat()).size !== info.size || (await lstat(path)).isSymbolicLink()) throw new Error("Unavailable ROM.");
        return bytes;
      } finally { await handle.close(); }
    } catch { throw new Error("Selected ROM is unavailable. Refresh the library and try again."); }
  }
}
