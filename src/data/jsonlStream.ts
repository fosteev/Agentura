import { open } from 'node:fs/promises';

/** Сколько читать за раз. Между кусками поток хоста свободен (`await`), строки по несколько МБ склеиваются. */
const CHUNK = 1024 * 1024;

export interface StreamLinesOptions {
  /** С какого байта читать (смещение после последней целой строки прошлого прохода). */
  start?: number;
  /** До какого байта (размер файла на момент `stat`): дописанное позже — следующему проходу. */
  end?: number;
  /**
   * Хвост без `\n` в конце файла. Строка, которую ещё пишут, оборвана и не разберётся — её не отдаём, смещение
   * остаётся на её начале. Закрытый файл без перевода строки в конце (фикстуры) — отдаём, если `accept` её
   * принял (обычно — если это целый JSON).
   */
  acceptTail?: (line: string) => boolean;
}

export interface StreamLinesResult {
  /** Смещение после последней отданной строки — отсюда следующий проход. */
  offset: number;
  /** Байт перед `offset` (`-1` при `offset = 0`) — проверка, что файл не переписали под тем же размером. */
  lastByte: number;
}

/**
 * Строки JSONL с байта `start` потоком: файл не грузится в память целиком, поток хоста не занят дольше одного
 * куска (этап 5 roadmap 0.2 — транскрипты по 50 МБ с base64 картинок и pdf). `\r` в конце строки снимается.
 */
export async function streamLines(
  path: string,
  onLine: (line: string) => void,
  options: StreamLinesOptions = {},
): Promise<StreamLinesResult> {
  const fh = await open(path, 'r');
  const start = options.start ?? 0;
  let pos = start;
  let offset = start;
  let lastByte = -1;
  const carry: Buffer[] = [];
  let carryBytes = 0;
  try {
    const end = options.end ?? (await fh.stat()).size;
    const buffer = Buffer.allocUnsafe(CHUNK);
    while (pos < end) {
      const { bytesRead } = await fh.read(buffer, 0, Math.min(CHUNK, end - pos), pos);
      if (bytesRead === 0) break;
      const chunk = buffer.subarray(0, bytesRead);
      let from = 0;
      for (let i = chunk.indexOf(0x0a); i >= 0; i = chunk.indexOf(0x0a, from)) {
        const segment = chunk.subarray(from, i);
        const line =
          carryBytes === 0
            ? segment.toString('utf8')
            : Buffer.concat([...carry, segment], carryBytes + segment.length).toString('utf8');
        carry.length = 0;
        carryBytes = 0;
        offset = pos + i + 1;
        lastByte = 0x0a;
        from = i + 1;
        onLine(stripCr(line));
      }
      if (from < chunk.length) {
        // буфер переиспользуется — хвост куска копируем
        const tail = Buffer.from(chunk.subarray(from));
        carry.push(tail);
        carryBytes += tail.length;
      }
      pos += bytesRead;
    }
    if (carryBytes > 0 && options.acceptTail) {
      const buf = Buffer.concat(carry, carryBytes);
      const line = stripCr(buf.toString('utf8'));
      if (options.acceptTail(line)) {
        offset = pos;
        lastByte = buf[buf.length - 1]!;
        onLine(line);
      }
    }
    if (offset > 0 && lastByte < 0) lastByte = await byteAt(fh, offset - 1);
  } finally {
    await fh.close();
  }
  return { offset, lastByte };
}

async function byteAt(fh: Awaited<ReturnType<typeof open>>, at: number): Promise<number> {
  const b = Buffer.alloc(1);
  const { bytesRead } = await fh.read(b, 0, 1, at);
  return bytesRead === 1 ? b[0]! : -1;
}

/** Байт файла по смещению (`-1` — нет такого). */
export async function readByteAt(path: string, at: number): Promise<number> {
  const fh = await open(path, 'r');
  try {
    return await byteAt(fh, at);
  } finally {
    await fh.close();
  }
}

/** Целая ли JSON-строка (для хвоста без `\n`). */
export function isJsonLine(line: string): boolean {
  if (line.trim() === '') return false;
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}
