import type { Json } from '#lib/live/types.ts';
import type { LabourLayer, RealmLayer, UserLayer } from '#lib/server/ui/agent.ts';

export type LabourLayerData = Json<LabourLayer>;
export type RealmLayerData = Json<RealmLayer>;
export type UserLayerData = Json<UserLayer>;

export const signed = (mood: number) => `${mood > 0 ? '+' : ''}${mood.toFixed(2)}`;
