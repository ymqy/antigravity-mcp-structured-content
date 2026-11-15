/**
 * O(N) newline-delimited JSON Buffer frame reader.
 *
 * Avoids both:
 * 1. UTF-8 multi-byte character corruption when arbitrary pipe/socket chunks split
 *    a 2-4 byte UTF-8 sequence across `data` events.
 * 2. Quadratic O(N^2) `Buffer.concat` copying when multi-megabyte payloads (such as
 *    5 MB+ Retina PNG screenshots in MCP CallToolResult) arrive in 16-64 KB chunks.
 */
export class JsonLineReader {
  #chunks = [];
  #totalBytes = 0;
  #onLine;

  /**
   * @param {(line: string) => void} onLine Invoked for each non-empty UTF-8 line.
   */
  constructor(onLine) {
    this.#onLine = onLine;
  }

  /**
   * Push a raw Buffer (or string) chunk into the frame accumulator.
   * @param {Buffer | string} chunk
   */
  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
    if (buf.length === 0) return;

    const firstNl = buf.indexOf(0x0a);
    if (firstNl === -1) {
      this.#chunks.push(buf);
      this.#totalBytes += buf.length;
      return;
    }

    // Assemble once when at least one newline arrives.
    let combined;
    if (this.#chunks.length === 0) {
      combined = buf;
    } else {
      this.#chunks.push(buf);
      combined = Buffer.concat(this.#chunks, this.#totalBytes + buf.length);
      this.#chunks = [];
      this.#totalBytes = 0;
    }

    let offset = 0;
    while (true) {
      const nl = combined.indexOf(0x0a, offset);
      if (nl === -1) break;
      let end = nl;
      if (end > offset && combined[end - 1] === 0x0d) {
        end -= 1;
      }
      if (end > offset) {
        const line = combined.toString('utf8', offset, end).trim();
        if (line) {
          this.#onLine(line);
        }
      }
      offset = nl + 1;
    }

    if (offset < combined.length) {
      // Copy trailing partial line into an independent small buffer so the large
      // multi-MB combined buffer can be garbage-collected immediately.
      const rem = Buffer.from(combined.subarray(offset));
      this.#chunks.push(rem);
      this.#totalBytes = rem.length;
    }
  }

  reset() {
    this.#chunks = [];
    this.#totalBytes = 0;
  }
}
