// Read-only ZIP support, enough to unpack a skill archive.
//
// The market hands us bytes from other people's servers, so this file refuses
// anything it cannot account for: entries outside the archive root (`../`),
// absolute paths, backslashes used as separators, symlinks, and encrypted
// entries are all dropped rather than sanitised into something plausible.
// Nothing here executes or inspects the payload beyond its own bookkeeping.

import zlib from 'node:zlib';

const END_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const MAX_ENTRIES = 5000;
const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

function findEndRecord(buffer) {
	// The end record sits in the last 22 bytes plus up to 64 KiB of comment.
	const floor = Math.max(0, buffer.length - 22 - 0xffff);
	for (let offset = buffer.length - 22; offset >= floor; offset -= 1) {
		if (buffer.readUInt32LE(offset) === END_SIGNATURE) return offset;
	}
	return -1;
}

export function listZip(buffer) {
	if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
		return { entries: [], error: 'not a zip archive' };
	}
	const end = findEndRecord(buffer);
	if (end < 0) return { entries: [], error: 'no end-of-central-directory record' };
	const count = buffer.readUInt16LE(end + 10);
	const directoryOffset = buffer.readUInt32LE(end + 16);
	if (count > MAX_ENTRIES) return { entries: [], error: `too many entries (${count})` };
	if (directoryOffset >= buffer.length) return { entries: [], error: 'central directory is outside the archive' };

	const entries = [];
	let cursor = directoryOffset;
	for (let index = 0; index < count; index += 1) {
		if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
			return { entries: [], error: 'central directory is truncated' };
		}
		const flags = buffer.readUInt16LE(cursor + 8);
		const method = buffer.readUInt16LE(cursor + 10);
		const compressedSize = buffer.readUInt32LE(cursor + 20);
		const uncompressedSize = buffer.readUInt32LE(cursor + 24);
		const nameLength = buffer.readUInt16LE(cursor + 28);
		const extraLength = buffer.readUInt16LE(cursor + 30);
		const commentLength = buffer.readUInt16LE(cursor + 32);
		const externalAttributes = buffer.readUInt32LE(cursor + 38);
		const localOffset = buffer.readUInt32LE(cursor + 42);
		const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');
		cursor += 46 + nameLength + extraLength + commentLength;
		const unixMode = externalAttributes >>> 16;
		entries.push({
			name,
			method,
			encrypted: (flags & 0x1) === 1,
			compressedSize,
			uncompressedSize,
			localOffset,
			isDirectory: name.endsWith('/'),
			isSymlink: (unixMode & 0xf000) === 0xa000,
		});
	}
	return { entries, error: null };
}

function safeName(name) {
	if (typeof name !== 'string' || name.length === 0) return null;
	if (name.includes('\\')) return null;
	if (name.startsWith('/') || /^[a-z]:/i.test(name)) return null;
	const parts = name.split('/').filter((part) => part.length > 0 && part !== '.');
	if (parts.length === 0) return null;
	if (parts.some((part) => part === '..')) return null;
	return parts.join('/');
}

/**
 * Unpack every file entry passing `accept` into `{ path, bytes }` pairs.
 *
 * Returns `{ files, skipped, error }`. `skipped` names entries that were
 * refused, so a caller can say what it dropped instead of pretending the
 * archive only had what survived.
 */
export function readZipFiles(buffer, { accept } = {}) {
	const { entries, error } = listZip(buffer);
	if (error) return { files: [], skipped: [], error };
	const files = [];
	const skipped = [];
	let unpacked = 0;
	for (const entry of entries) {
		if (entry.isDirectory) continue;
		const path = safeName(entry.name);
		if (!path) {
			skipped.push({ name: entry.name, reason: 'unsafe path' });
			continue;
		}
		if (entry.isSymlink) {
			skipped.push({ name: entry.name, reason: 'symlink' });
			continue;
		}
		if (entry.encrypted) {
			skipped.push({ name: entry.name, reason: 'encrypted' });
			continue;
		}
		if (entry.method !== 0 && entry.method !== 8) {
			skipped.push({ name: entry.name, reason: `compression method ${entry.method}` });
			continue;
		}
		if (!accept || accept(path)) {
			unpacked += entry.uncompressedSize;
			if (unpacked > MAX_UNPACKED_BYTES) {
				return { files: [], skipped, error: `archive expands past ${MAX_UNPACKED_BYTES} bytes` };
			}
			const local = entry.localOffset;
			if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
				skipped.push({ name: entry.name, reason: 'missing local header' });
				continue;
			}
			const localNameLength = buffer.readUInt16LE(local + 26);
			const localExtraLength = buffer.readUInt16LE(local + 28);
			const dataStart = local + 30 + localNameLength + localExtraLength;
			const dataEnd = dataStart + entry.compressedSize;
			if (dataEnd > buffer.length) {
				skipped.push({ name: entry.name, reason: 'payload runs past the archive' });
				continue;
			}
			const raw = buffer.subarray(dataStart, dataEnd);
			let bytes;
			try {
				bytes = entry.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
			} catch (inflateError) {
				skipped.push({ name: entry.name, reason: `inflate failed: ${inflateError.message}` });
				continue;
			}
			if (bytes.length > entry.uncompressedSize) {
				skipped.push({ name: entry.name, reason: 'larger than declared' });
				continue;
			}
			files.push({ path, bytes });
		} else {
			skipped.push({ name: entry.name, reason: 'filtered' });
		}
	}
	return { files, skipped, error: null };
}
