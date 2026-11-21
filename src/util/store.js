// =============================================================================
// store.js  -  a tiny JSON "database" saved to disk.
// -----------------------------------------------------------------------------
// We only need to remember a few things between restarts (which ransomware
// cases we are tracking and which alerts were already sent), so a JSON file in
// the ./data folder (a Docker volume) is plenty. Writes are "atomic": we write
// to a temp file and then rename it, so a crash can never leave half a file.
// =============================================================================
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { log } from './logger.js';

export class JsonStore {
  /** @param {string} name file name inside DATA_DIR, e.g. "ransom.json" */
  constructor(name, defaults) {
    // path.basename() guarantees nobody can sneak "../" into the file name.
    this.file = path.resolve(config.dataDir, path.basename(name));
    this.defaults = defaults;
    this.data = structuredClone(defaults);
    this.writing = Promise.resolve(); // serialises writes so they never overlap
  }

  /** Load the file from disk (or keep defaults if it does not exist yet). */
  async load() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      this.data = { ...structuredClone(this.defaults), ...JSON.parse(raw) };
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn('store', `could not read ${this.file}: ${err.message}`);
    }
    return this.data;
  }

  /** Save the current data to disk (queued, atomic). */
  save() {
    this.writing = this.writing.then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
        await fs.rename(tmp, this.file);
      } catch (err) {
        log.error('store', `could not write ${this.file}: ${err.message}`);
      }
    });
    return this.writing;
  }
}
