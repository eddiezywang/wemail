import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export type ShortcutLocation = "desktop" | "startMenu";

export interface ShortcutEntryState {
	location: ShortcutLocation;
	path: string;
	exists: boolean;
	target: string;
	correct: boolean;
}

export interface ShortcutStatus {
	entries: ShortcutEntryState[];
	/** Windows-only; true when the user should be prompted. */
	prompt: boolean;
	/** User chose 稍后再说 for this exact exe — stays quiet until the exe path changes. */
	dismissed: boolean;
	currentExe: string;
}

export interface ShortcutControllerOptions {
	desktopPath: string;
	startMenuPath: string;
	dataDir: string;
	currentExe: string;
	/** Test seam. */
	runPs?: (script: string) => Promise<string>;
}

const LNK_NAME = "WeMail.lnk";
/** PowerShell tab escape — the join marker between path and target. */
const T = "`t";
const MARKER_NAME = "shortcut-prompt.json";
const MISSING_SENTINEL = "<wemail-missing>";

function encodePs(script: string): string {
	return Buffer.from(script, "utf16le").toString("base64");
}

function runPowerShell(script: string): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"powershell.exe",
			["-NoProfile", "-NonInteractive", "-EncodedCommand", encodePs(script)],
			{ windowsHide: true, timeout: 15_000, maxBuffer: 1_000_000 },
			(error, stdout) => {
				if (error) reject(error);
				else resolve(stdout);
			},
		);
	});
}

function psString(value: string): string {
	return `'${value.replaceAll("'", "''")}'`;
}

function lnkPaths(options: ShortcutControllerOptions): Array<{
	location: ShortcutLocation;
	path: string;
}> {
	return [
		{ location: "desktop", path: path.join(options.desktopPath, LNK_NAME) },
		{
			location: "startMenu",
			path: path.join(options.startMenuPath, LNK_NAME),
		},
	];
}

function sameExecutable(a: string, b: string): boolean {
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Pure decision core: which entries are wrong and whether to prompt. */
export function evaluateShortcutState(
	entries: ShortcutEntryState[],
	currentExe: string,
	dismissed: boolean,
): { prompt: boolean } {
	const broken = entries.some(
		(entry) => !entry.exists || !sameExecutable(entry.target, currentExe),
	);
	return { prompt: broken && !dismissed };
}

function parseStatusOutput(
	stdout: string,
	options: ShortcutControllerOptions,
): ShortcutEntryState[] {
	const currentExe = options.currentExe;
	return lnkPaths(options).map(({ location, path: lnkPath }) => {
		const line = stdout
			.split("\n")
			.map((candidate) => candidate.trim())
			.find((candidate) =>
				candidate.toLowerCase().startsWith(lnkPath.toLowerCase()),
			);
		if (!line) {
			return { location, path: lnkPath, exists: false, target: "", correct: false };
		}
		const target = line.slice(lnkPath.length + 1).trim();
		const exists = !target.startsWith(MISSING_SENTINEL);
		return {
			location,
			path: lnkPath,
			exists,
			target: exists ? target : "",
			correct: exists && sameExecutable(target, currentExe),
		};
	});
}

function readDismissedExe(options: ShortcutControllerOptions): string | null {
	try {
		const marker = JSON.parse(
			fs.readFileSync(
				path.join(options.dataDir, MARKER_NAME),
				"utf8",
			),
		) as { exe?: string };
		return typeof marker.exe === "string" ? marker.exe : null;
	} catch {
		return null;
	}
}

export function createShortcutController(options: ShortcutControllerOptions) {
	const runPs = options.runPs ?? runPowerShell;

	return {
		async status(): Promise<ShortcutStatus> {
			const paths = lnkPaths(options);
			const script = [
				`$ws = New-Object -ComObject WScript.Shell`,
				...paths.map(
					({ path: lnkPath }) =>
						`if (Test-Path ${psString(lnkPath)}) { `
						+ `${psString(lnkPath)} + "` + T + `" + $ws.CreateShortcut(${psString(lnkPath)}).TargetPath `
						+ `} else { ${psString(lnkPath)} + "` + T + `" + ${psString(MISSING_SENTINEL)} }`,
				),
			].join("\n");
			const entries = parseStatusOutput(await runPs(script), options);
			const dismissedExe = readDismissedExe(options);
			const dismissed = dismissedExe === options.currentExe;
			const { prompt } = evaluateShortcutState(entries, options.currentExe, dismissed);
			return { entries, prompt, dismissed, currentExe: options.currentExe };
		},

		async fix(): Promise<void> {
			const target = options.currentExe;
			const workDir = path.dirname(target);
			const script = [
				`$ws = New-Object -ComObject WScript.Shell`,
				`$target = ${psString(target)}`,
				`$workdir = ${psString(workDir)}`,
				...lnkPaths(options).map(
					({ path: lnkPath }) =>
						`$s = $ws.CreateShortcut(${psString(lnkPath)}); `
						+ `$s.TargetPath = $target; `
						+ `$s.WorkingDirectory = $workdir; `
						+ `$s.IconLocation = "$target,0"; `
						+ `$s.Save()`,
				),
				`Write-Output OK`,
			].join("\n");
			const stdout = await runPs(script);
			if (!stdout.includes("OK")) throw new Error("shortcut write failed");
			try {
				fs.rmSync(path.join(options.dataDir, MARKER_NAME), { force: true });
			} catch {
				// marker cleanup is best-effort
			}
		},

		dismiss(): void {
			fs.writeFileSync(
				path.join(options.dataDir, MARKER_NAME),
				JSON.stringify({ exe: options.currentExe }),
			);
		},
	};
}

