import { activity } from './activity.ts';
import { affinity } from './affinity.ts';
import { age } from './age.ts';
import { column } from './column.ts';
import { evidence } from './evidence.ts';
import { keywords } from './keywords.ts';
import { mentions } from './mentions.ts';
import { pulledIn } from './pulled-in.ts';
import { questFinish } from './quest-finish.ts';
import { delight, pain, sentiment } from './sentiment.ts';
import { similarity } from './similarity.ts';
import { skillFit } from './skill-fit.ts';
import type { Feature } from './types.ts';
import { unblocks } from './unblocks.ts';

export type { Feature, FeatureContext } from './types.ts';

const BUILT_IN: Feature[] = [
	keywords,
	mentions,
	pulledIn,
	evidence,
	unblocks,
	questFinish,
	column,
	age,
	activity,
	sentiment,
	pain,
	delight,
	skillFit,
	affinity,
	similarity
];

export const FEATURES: Readonly<Record<string, Feature>> = Object.fromEntries(
	BUILT_IN.map((feature) => [feature.name, feature])
);

// Feature names a weight may use but no module computes.
export const LATER_FEATURES: readonly string[] = [];
