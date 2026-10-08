import { z } from 'zod';
import { isHueLamp } from './rig.ts';
import type { ChannelMap, Profile, StageFixture } from '../types/rig.ts';

export const OUTPUT_TECHNOLOGIES = ['dmx', 'ddp', 'openrgb', 'hue'] as const;
export type OutputTechnology = typeof OUTPUT_TECHNOLOGIES[number];
export type AdmissionPolicy = 'max' | 'hold' | 'exclude';
export type Die = 'r' | 'g' | 'b' | 'w' | 'a' | 'uv';
export interface RateLimits { maxFlashHz: number; minTransitionMs: number; evidence?: string; verifiedFlashHz?: number }
export type RateOverride = Partial<RateLimits>;
export interface ProductLimits extends RateLimits { name: string; technology: OutputTechnology }
export interface HardwareSettings {
  technologies: Partial<Record<OutputTechnology, RateOverride>>;
  products: Record<string, ProductLimits>;
}
export interface HardwareCaps extends RateLimits {
  technology: OutputTechnology;
  productId: string;
  productName: string;
  source: 'technology' | 'profile' | 'product' | 'device';
  measured: boolean;
  channels: Die[];
  pixels: number;
  strobeHz: { min: number; max: number } | null;
  policy: AdmissionPolicy;
}
export interface OutputNeeds { flashHz: number; hardwareChannel?: boolean; transitionMs?: number; pixels?: boolean; channels?: readonly Die[] }
export interface HardwareDecision { mode: 'play' | 'slower' | 'hold' | 'exclude'; ratio: number; limitHz: number }

// Starting limits describe renderer policy, not a measurement of connected lamps.
export const TECHNOLOGY_LIMITS: Readonly<Record<OutputTechnology, RateLimits>> = Object.freeze({
  dmx: { maxFlashHz: 20, minTransitionMs: 1000 / 44 },
  ddp: { maxFlashHz: 20, minTransitionMs: 1000 / 44 },
  openrgb: { maxFlashHz: 20, minTransitionMs: 1000 / 44 },
  hue: { maxFlashHz: 5, minTransitionMs: 40 },
});
export const DEFAULT_HARDWARE: HardwareSettings = { technologies: {}, products: {} };
export const admissionPolicySchema = z.enum(['max', 'hold', 'exclude']);
export const rateFields = {
  maxFlashHz: z.number().finite().min(0.1).max(100),
  minTransitionMs: z.number().finite().min(0).max(10000),
  evidence: z.string().trim().max(500).optional(),
  verifiedFlashHz: z.number().finite().min(0.1).max(100).optional(),
};
export const rateOverrideSchema = z.object(rateFields).partial().strict();
const productSchema = z.object({ name: z.string().trim().min(1).max(80), technology: z.enum(OUTPUT_TECHNOLOGIES), ...rateFields }).strict();
export const hardwareSettingsSchema = z.object({
  technologies: z.object(Object.fromEntries(OUTPUT_TECHNOLOGIES.map((t) => [t, rateOverrideSchema.optional()])) as Record<OutputTechnology, z.ZodOptional<typeof rateOverrideSchema>>).strict(),
  products: z.record(z.string().min(1).max(128).refine((id) => !['__proto__', 'constructor', 'prototype'].includes(id), 'reserved product id'), productSchema)
    .refine((products) => Object.keys(products).length <= 128, 'at most 128 products'),
}).strict();

export function technologyOf(fixture: StageFixture): OutputTechnology {
  const protocol = fixture.output?.protocol;
  return protocol === 'ddp' || protocol === 'openrgb' || protocol === 'hue' ? protocol : isHueLamp(fixture) ? 'hue' : 'dmx';
}

const CHANNELS: Record<Die, readonly string[]> = {
  r: ['red'], g: ['green'], b: ['blue'], w: ['white', 'coolWhite'], a: ['amber', 'warmWhite'], uv: ['uv'],
};
export function channelsOf(maps: readonly ChannelMap[]): Die[] {
  return (Object.keys(CHANNELS) as Die[]).filter((die) => maps.some((m) => CHANNELS[die].some((key) => m[key] !== undefined)));
}

export function hardwareOf(fixture: StageFixture & { productId?: string | null; hardware?: RateOverride | null; admission?: AdmissionPolicy | null },
  profile: Profile | null | undefined, settings: HardwareSettings = DEFAULT_HARDWARE): HardwareCaps {
  const technology = technologyOf(fixture), productId = fixture.productId || profile?.id || 'unknown';
  const product = settings.products[productId];
  let rates: RateLimits = { ...TECHNOLOGY_LIMITS[technology] }, source: HardwareCaps['source'] = 'technology';
  const apply = (next: RateOverride | null | undefined, level: HardwareCaps['source']) => {
    if (!next || !Object.keys(next).length) return;
    rates = { ...rates, ...next, evidence: next.evidence, verifiedFlashHz: next.verifiedFlashHz };
    source = level;
  };
  apply(settings.technologies[technology], 'technology');
  apply(profile?.hardware as RateOverride | undefined, 'profile');
  if (product?.technology === technology) apply(product, 'product');
  apply(fixture.hardware, 'device');
  const maps = profile?.cells?.length ? profile.cells.map((c) => c.channelMap) : [profile?.channelMap ?? {}];
  const strobe = profile?.strobeHz as { min: number; max: number } | undefined;
  return { ...rates, technology, productId, productName: product?.technology === technology ? product.name : profile?.name ?? productId,
    source, measured: !!rates.evidence?.trim() && (rates.verifiedFlashHz ?? 0) >= rates.maxFlashHz,
    channels: channelsOf(maps), pixels: Math.max(1, profile?.cells?.length ?? 1),
    strobeHz: profile?.channelMap.strobe !== undefined ? strobe ?? { min: 1, max: 20 } : null,
    policy: fixture.admission ?? 'max' };
}

export function stricterPolicy(...policies: (AdmissionPolicy | null | undefined)[]): AdmissionPolicy {
  return policies.includes('exclude') ? 'exclude' : policies.includes('hold') ? 'hold' : 'max';
}

export function maximumFlashHz(caps: RateLimits): number {
  return Math.min(caps.maxFlashHz, caps.minTransitionMs > 0 ? 500 / caps.minTransitionMs : Infinity);
}

export function hardwareDecision(needs: OutputNeeds, caps: HardwareCaps, policy?: AdmissionPolicy | null): HardwareDecision {
  const limitHz = Math.min(needs.hardwareChannel && caps.strobeHz ? Infinity : 22, maximumFlashHz(caps));
  const ratio = Math.min(1, needs.flashHz > 0 ? limitHz / needs.flashHz : 1,
    needs.transitionMs && caps.minTransitionMs > 0 ? needs.transitionMs / caps.minTransitionMs : 1);
  const limited = ratio < 1 - 1e-9 || !!needs.pixels && caps.pixels <= 1
    || !!needs.channels?.some((ch) => !caps.channels.includes(ch));
  const selected = stricterPolicy(policy, caps.policy);
  return { mode: !limited ? 'play' : selected === 'max' ? 'slower' : selected, ratio, limitHz };
}
