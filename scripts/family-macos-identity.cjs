const { createHash } = require("node:crypto");

/** Give the family build its own stable identity before electron-builder signs it.
 * macOS Local Network privacy otherwise associates Electron's shared LC_UUID
 * with com.github.Electron instead of this app (Apple TN3179).
 */
function familyMacIdentity(binary, appId) {
	if (binary.readUInt32LE(0) !== 0xfeedfacf) throw new Error("Expected a 64-bit Mach-O executable");
	const commands = binary.readUInt32LE(16);
	const end = 32 + binary.readUInt32LE(20);
	if (end > binary.length) throw new Error("Truncated Mach-O load commands");
	const uuids = [];
	let offset = 32;
	for (let i = 0; i < commands; i++) {
		if (offset + 8 > end) throw new Error("Truncated Mach-O load command");
		const type = binary.readUInt32LE(offset);
		const size = binary.readUInt32LE(offset + 4);
		if (size < 8 || offset + size > end) throw new Error("Invalid Mach-O load command size");
		if (type === 0x1b) {
			if (size !== 24) throw new Error("Invalid Mach-O UUID command");
			uuids.push(offset + 8);
		}
		offset += size;
	}
	if (uuids.length !== 1) throw new Error("Expected exactly one Mach-O UUID");
	const uuid = createHash("sha256").update(`${appId}:macos-main-executable`).digest().subarray(0, 16);
	uuid[6] = (uuid[6] & 0x0f) | 0x50;
	uuid[8] = (uuid[8] & 0x3f) | 0x80;
	uuid.copy(binary, uuids[0]);
	return binary;
}

module.exports = { familyMacIdentity };
