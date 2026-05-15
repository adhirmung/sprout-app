/**
 * PDF text extractor — handles both plain and FlateDecode-compressed streams.
 * Strategy 1 (sync): regex over raw BT/ET blocks — works for uncompressed PDFs.
 * Strategy 2 (async): decompress each FlateDecode stream via DecompressionStream,
 *   then parse BT/ET blocks from the decompressed content.
 * Returns empty string for image-only / scanned PDFs.
 */

function pdfDecode(s: string): string {
  return s
    .replace(/\\n/g, ' ')
    .replace(/\\r/g, ' ')
    .replace(/\\t/g, ' ')
    .replace(/\\\\/g, '\\')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\([0-7]{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
}

function parseTextOps(block: string): string[] {
  const parts: string[] = [];

  // (string) Tj  or  (string) '  or  (string) "
  const tjRx = /\(([^)\\]{0,500}(?:\\.[^)\\]{0,500})*)\)\s*(?:Tj|'|")/g;
  let sm: RegExpExecArray | null;
  while ((sm = tjRx.exec(block)) !== null) parts.push(pdfDecode(sm[1]));

  // [(str1)(str2)…] TJ
  const arrRx = /\[([\s\S]{0,2000}?)\]\s*TJ/g;
  let am: RegExpExecArray | null;
  while ((am = arrRx.exec(block)) !== null) {
    const pRx = /\(([^)\\]{0,300}(?:\\.[^)\\]{0,300})*)\)/g;
    let pm: RegExpExecArray | null;
    while ((pm = pRx.exec(am[1])) !== null) parts.push(pdfDecode(pm[1]));
  }

  return parts;
}

function extractFromRaw(raw: string): string[] {
  const parts: string[] = [];

  // Strategy A: BT … ET text blocks
  const btEtRx = /BT\s([\s\S]{1,8000}?)ET/g;
  let m: RegExpExecArray | null;
  while ((m = btEtRx.exec(raw)) !== null) {
    parts.push(...parseTextOps(m[1]));
  }

  // Strategy B: fallback — bare Tj outside BT/ET
  if (parts.length < 5) {
    const fallRx = /\(([^\x00-\x08\x0b\x0c\x0e-\x1f)\\]{3,200})\)\s*Tj/g;
    while ((m = fallRx.exec(raw)) !== null) {
      const s = pdfDecode(m[1]);
      if (/[a-zA-Z]{2}/.test(s)) parts.push(s);
    }
  }

  return parts;
}

function joinParts(parts: string[]): string {
  return parts
    .filter(s => s.trim().length > 1 && /[a-zA-Z]/.test(s))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Synchronous extraction — works for uncompressed PDFs. */
export function extractPdfText(buffer: ArrayBuffer): string {
  const bytes  = new Uint8Array(buffer);
  const CHUNK  = 32768;
  let   raw    = '';
  for (let off = 0; off < bytes.length; off += CHUNK) {
    const slice = bytes.subarray(off, Math.min(off + CHUNK, bytes.length));
    raw += Array.from(slice, b => String.fromCharCode(b)).join('');
  }
  return joinParts(extractFromRaw(raw));
}

/** Async extraction — decompresses FlateDecode streams, then parses text. */
export async function extractPdfTextAsync(buffer: ArrayBuffer): Promise<string> {
  // Try sync path first (fast, works for plain-text PDFs)
  const syncResult = extractPdfText(buffer);
  if (syncResult.length > 100) return syncResult;

  // Compressed path: find all FlateDecode streams and decompress them
  const bytes = new Uint8Array(buffer);

  // Build a latin-1 string only for dictionary scanning (not stream bytes)
  const SCAN_CHUNK = 32768;
  let rawStr = '';
  for (let off = 0; off < bytes.length; off += SCAN_CHUNK) {
    const sl = bytes.subarray(off, Math.min(off + SCAN_CHUNK, bytes.length));
    rawStr += Array.from(sl, b => String.fromCharCode(b)).join('');
  }

  const allParts: string[] = [];

  // Locate each 'stream' keyword preceded by a FlateDecode dictionary
  const streamMarker = /(?:\/FlateDecode)[^>]*>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;

  while ((m = streamMarker.exec(rawStr)) !== null) {
    const streamDataStart = m.index + m[0].length;

    // Find the matching 'endstream'
    const endIdx = rawStr.indexOf('endstream', streamDataStart);
    if (endIdx === -1) continue;

    // Strip a possible trailing \r\n before endstream
    let streamDataEnd = endIdx;
    if (rawStr[streamDataEnd - 1] === '\n') streamDataEnd--;
    if (rawStr[streamDataEnd - 1] === '\r') streamDataEnd--;

    const streamBytes = bytes.slice(streamDataStart, streamDataEnd);

    try {
      const decompressed = await decompressZlib(streamBytes);
      const decompStr = Array.from(decompressed, b => String.fromCharCode(b)).join('');
      allParts.push(...extractFromRaw(decompStr));
    } catch {
      // stream was not actually deflate — skip it
    }
  }

  return joinParts(allParts);
}

async function decompressZlib(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const writer = ds.writable.getWriter();
  writer.write(data as unknown as BufferSource);
  writer.close();

  const chunks: Uint8Array[] = [];
  const reader = ds.readable.getReader();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
