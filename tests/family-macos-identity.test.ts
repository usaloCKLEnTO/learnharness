import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { it } from "node:test";

const { familyMacIdentity } = createRequire(import.meta.url)("../scripts/family-macos-identity.cjs");
function executable() {
	const binary = Buffer.alloc(64, 0x12);
	binary.writeUInt32LE(0xfeedfacf, 0);
	binary.writeUInt32LE(1, 16);
	binary.writeUInt32LE(24, 20);
	binary.writeUInt32LE(0x1b, 32);
	binary.writeUInt32LE(24, 36);
	return binary;
}

it("changes only the executable UUID, consistently for the app identity", () => {
	const original = executable();
	const modified = familyMacIdentity(Buffer.from(original), "family.test");
	assert.deepEqual(modified.subarray(0, 40), original.subarray(0, 40));
	assert.deepEqual(modified.subarray(56), original.subarray(56));
	assert.notDeepEqual(modified.subarray(40, 56), original.subarray(40, 56));
	assert.deepEqual(familyMacIdentity(executable(), "family.test"), modified);
	assert.notDeepEqual(familyMacIdentity(executable(), "other.test"), modified);
});

it("refuses unexpected or truncated Mach-O structures before patching", () => {
	assert.throws(() => familyMacIdentity(Buffer.alloc(64), "test"), /Mach-O/);
	assert.throws(() => familyMacIdentity(executable().subarray(0, 40), "test"), /Truncated/);
	const malformed = executable();
	malformed.writeUInt32LE(0, 36);
	assert.throws(() => familyMacIdentity(malformed, "test"), /size/);
});
