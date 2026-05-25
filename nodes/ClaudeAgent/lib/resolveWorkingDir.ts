export function resolveWorkingDir(params: {
	skillsRoot?: string;
	workingDirectories?: string | string[];
	legacyWorkingDirectory?: string;
}): { cwd: string; additionalDirectories: string[] } | undefined {
	const ordered: string[] = [];

	const skillsRoot = params.skillsRoot?.trim();
	if (skillsRoot) ordered.push(skillsRoot);

	const rawDirs = params.workingDirectories;
	const dirList = Array.isArray(rawDirs) ? rawDirs : rawDirs ? [rawDirs] : [];

	for (const dir of dirList) {
		const trimmed = String(dir ?? '').trim();
		if (trimmed) ordered.push(trimmed);
	}

	const legacy = params.legacyWorkingDirectory?.trim();
	if (legacy) ordered.push(legacy);

	const unique = [...new Set(ordered)];
	if (unique.length === 0) {
		return undefined;
	}

	return {
		cwd: unique[0],
		additionalDirectories: unique.slice(1),
	};
}
