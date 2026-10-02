import { inflateRawSync } from "node:zlib";

/** Contents of the first file in a zip archive (Binance's data archive ships one CSV per zip). */
export function firstZipEntry(buf: Buffer): string {
  if (buf.readUInt32LE(0) !== 0x04034b50) throw new Error("no es un archivo zip");
  const method = buf.readUInt16LE(8);
  const flags = buf.readUInt16LE(6);
  let size = buf.readUInt32LE(18);
  const start = 30 + buf.readUInt16LE(26) + buf.readUInt16LE(28);
  if (flags & 0x08 || size === 0) {
    // Sizes live in the central directory when the local header defers them.
    const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const central = buf.readUInt32LE(eocd + 16);
    size = buf.readUInt32LE(central + 20);
  }
  const data = buf.subarray(start, start + size);
  if (method === 0) return data.toString("utf8");
  if (method === 8) return inflateRawSync(data).toString("utf8");
  throw new Error(`compresión zip no soportada (${method})`);
}
