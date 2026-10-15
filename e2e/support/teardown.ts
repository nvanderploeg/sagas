import { rmSync } from 'node:fs';
import { runDir } from './env.ts';

export default function teardown(): void {
	rmSync(runDir, { recursive: true, force: true });
}
