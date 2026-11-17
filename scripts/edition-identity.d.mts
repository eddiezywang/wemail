/**
 * Type declarations for scripts/edition-identity.mjs so the TypeScript
 * generator (scripts/write-edition-config.ts) imports it type-safely.
 */
export declare const EDITION_IDENTITY_FILENAME: ".edition-identity.json";
export declare const OPEN_EDITION_OVERLAY_ID: "open-default";
export declare interface EditionIdentity {
	profile: "open" | "internal";
	overlay: string;
}
export declare function editionIdentityFromEnv(
	env?: Record<string, string | undefined>,
	readFileSync?: (path: string) => Buffer,
): EditionIdentity;
export declare function recordedEditionIdentity(
	buildEditionDirectory: string,
	readFileSync?: (path: string, encoding: "utf8") => string,
): EditionIdentity | null;
export declare function assertPackagingEditionIdentity(options: {
	root: string;
	env?: Record<string, string | undefined>;
	readFileSync?: ((path: string) => Buffer) & ((path: string, encoding: "utf8") => string);
	existsSync?: (path: string) => boolean;
}): EditionIdentity;
