/** Retain the native parsed provider result before producing a bounded view.
 * No provider client, credential loader, ranking, summarizer or retry engine.
 * The existing authenticated owner supplies the private store, not the caller.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

type JsonRecord = Record<string, unknown>;
export type CaptureContext = { providerRef: string; nativeTool: string; arguments: JsonRecord };
export type CaptureSection = 'manifest' | 'text' | 'structured' | 'raw';
export type CaptureRead = { captureRef: string; section?: CaptureSection; offset?: number; length?: number; find?: string };
export type CaptureManifest = {
  captureRef: string; uri: string; bytes: number; capturedAt: string;
  providerRef: string; nativeTool: string; requestSha256: string;
  textCharacters: number; contentBlocks: number; contentTypes: string[];
  hasStructuredContent: boolean; providerIsError: boolean;
  sourceRepresentation: string; providerCompleteness: 'not_inferred';
};
type Envelope = { schemaVersion: 1; capturedAt: string; providerRef: string;
  nativeTool: string; requestSha256: string; result: JsonRecord };

const SCHEME = 'zes-research://capture/';
const REF = /^[a-f0-9]{64}$/;
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const record = (value: unknown): value is JsonRecord => typeof value === 'object' && value !== null && !Array.isArray(value);
const own = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

function validateResult(value: unknown): asserts value is JsonRecord {
  if (!record(value)) throw new TypeError('Provider result is not an object');
  if (value.isError !== undefined && typeof value.isError !== 'boolean') {
    throw new TypeError('Provider error flag is not Boolean');
  }
  if (!Array.isArray(value.content) || value.content.some(block => !record(block)
      || typeof block.type !== 'string' || (block.type === 'text' && typeof block.text !== 'string'))) {
    throw new TypeError('Provider content is malformed; no empty success inferred');
  }
}

export function providerText(result: JsonRecord): string {
  return (result.content as JsonRecord[]).filter(block => block.type === 'text')
    .map(block => block.text as string).join('\n\n');
}

function windowOf(text: string, offset = 0, length = 4000) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(length)
      || length < 1 || length > 100_000) throw new RangeError('Invalid capture read window');
  // Offsets and budgets are Unicode code points, never UTF-8 bytes/model tokens.
  const points = Array.from(text);
  if (offset > points.length) throw new RangeError('Capture offset exceeds this immutable section');
  const end = Math.min(points.length, offset + length);
  return { text: points.slice(offset, end).join(''), offset, nextOffset: end < points.length ? end : null,
    totalCharacters: points.length, omittedCharacters: points.length - (end - offset),
    coordinate: 'unicode_code_points' as const };
}

export class ResearchCaptureStore {
  readonly root: string;
  readonly maxCaptureBytes: number;
  constructor(root: string, maxCaptureBytes = 8 * 1024 * 1024) {
    this.root = resolve(root);
    if (!Number.isSafeInteger(maxCaptureBytes) || maxCaptureBytes < 1024) throw new RangeError('Invalid store limit');
    this.maxCaptureBytes = maxCaptureBytes;
  }

  async ready(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const stat = await lstat(this.root);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
        || await realpath(this.root) !== this.root) {
      throw new Error('Capture root must be a private real directory owned by the service');
    }
  }

  async capture(value: unknown, context: CaptureContext, previewCharacters = 4000) {
    validateResult(value);
    windowOf('', 0, previewCharacters); // Validate before any retention effect.
    // Only allowlisted provenance enters the envelope; never spread a provider route/config.
    const envelope: Envelope = { schemaVersion: 1, capturedAt: new Date().toISOString(),
      providerRef: context.providerRef, nativeTool: context.nativeTool,
      requestSha256: hash(JSON.stringify(context.arguments)), result: value };
    const bytes = Buffer.from(JSON.stringify(envelope));
    if (bytes.length > this.maxCaptureBytes) throw new RangeError('Provider result exceeds admitted capture size; nothing retained');
    const captureRef = hash(bytes);
    await this.ready();
    const temporary = join(this.root, `.${randomUUID()}.partial`);
    const destination = join(this.root, `${captureRef}.json`);
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
    try {
      try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
      try { await link(temporary, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await this.load(captureRef); // Same reference must still match its content digest.
      }
    } finally { await unlink(temporary); }
    const loaded = JSON.parse(bytes.toString()) as Envelope;
    const manifest = this.manifest(captureRef, loaded, bytes.length);
    const view = windowOf(providerText(loaded.result), 0, previewCharacters);
    return { text: view.text, structuredContent: null, contentTypes: manifest.contentTypes,
      textTruncated: view.nextOffset !== null,
      structuredContentTruncated: manifest.hasStructuredContent,
      isError: manifest.providerIsError, capture: manifest,
      preview: { ...view, text: undefined },
      nextRead: { action: 'capture_read', captureRef, section: 'manifest' } };
  }

  private manifest(captureRef: string, e: Envelope, bytes: number): CaptureManifest {
    const blocks = e.result.content as JsonRecord[];
    return { captureRef, uri: SCHEME + captureRef, bytes, capturedAt: e.capturedAt,
      providerRef: e.providerRef, nativeTool: e.nativeTool, requestSha256: e.requestSha256,
      textCharacters: Array.from(providerText(e.result)).length, contentBlocks: blocks.length,
      contentTypes: [...new Set(blocks.map(b => b.type as string))].slice(0, 32),
      hasStructuredContent: own(e.result, 'structuredContent'), providerIsError: e.result.isError === true,
      sourceRepresentation: 'JSON serialization of native parsed CallToolResult; not HTTP wire bytes or entire source documents',
      providerCompleteness: 'not_inferred' };
  }

  private async load(captureRef: string): Promise<{ bytes: Buffer; envelope: Envelope }> {
    if (!REF.test(captureRef)) throw new TypeError('Invalid opaque capture reference');
    await this.ready();
    const file = await open(join(this.root, `${captureRef}.json`), constants.O_RDONLY | NOFOLLOW);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > this.maxCaptureBytes) throw new Error('Invalid capture file');
      const bytes = await file.readFile();
      if (bytes.length > this.maxCaptureBytes || hash(bytes) !== captureRef) throw new Error('Capture digest mismatch');
      const envelope = JSON.parse(bytes.toString()) as Envelope;
      if (envelope.schemaVersion !== 1) throw new Error('Unsupported capture schema');
      validateResult(envelope.result);
      return { bytes, envelope };
    } finally { await file.close(); }
  }

  async read(input: CaptureRead) {
    const section = input.section ?? 'manifest';
    if (!['manifest', 'text', 'structured', 'raw'].includes(section)) throw new TypeError('Unknown capture section');
    const { bytes, envelope } = await this.load(input.captureRef);
    const manifest = this.manifest(input.captureRef, envelope, bytes.length);
    if (section === 'manifest') return { manifest };
    if (section === 'structured' && !manifest.hasStructuredContent) {
      return { captureRef: input.captureRef, section, present: false, text: null, nextOffset: null };
    }
    const text = section === 'text' ? providerText(envelope.result)
      : section === 'structured' ? JSON.stringify(envelope.result.structuredContent)
      : bytes.toString();
    if (input.find !== undefined) {
      if (section !== 'text' || typeof input.find !== 'string' || input.find.length < 1 || input.find.length > 1000) {
        throw new TypeError('Literal find requires a nonempty text needle of at most1000 UTF-16 units');
      }
      const validated = windowOf(text, input.offset, input.length);
      const startCodeUnits = Array.from(text).slice(0, validated.offset).join('').length;
      const hits: Array<{offset: number; text: string; matchCharacters: number}> = [];
      let cursor = startCodeUnits;
      while (hits.length < 20) {
        const position = text.indexOf(input.find, cursor);
        if (position === -1) break;
        const offset = Array.from(text.slice(0, position)).length;
        const snippet = windowOf(text, offset, Math.min(input.length ?? 160, 1000));
        hits.push({offset, text: snippet.text, matchCharacters: Array.from(input.find).length});
        cursor = position + input.find.length;
      }
      const more = text.indexOf(input.find, cursor) !== -1;
      return { captureRef: input.captureRef, section, find: input.find, matches: hits,
        nextOffset: more ? Array.from(text.slice(0, cursor)).length : null,
        limited: more, coordinate: 'unicode_code_points', method: 'literal_string_match_not_semantic_search' };
    }
    return { captureRef: input.captureRef, section, present: true,
      ...windowOf(text, input.offset, input.length), providerCompleteness: 'not_inferred' };
  }

  async resource(uri: string) {
    if (!uri.startsWith(SCHEME)) throw new TypeError('Unknown capture resource');
    const captureRef = uri.slice(SCHEME.length);
    const { bytes } = await this.load(captureRef);
    return { contents: [{ uri, mimeType: 'application/json', text: bytes.toString() }] };
  }
}
