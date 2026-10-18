/** Kontrakt zgodny z docs/00_BLUEPRINT_A_B.md (vec-v1). */

export const VECTOR_TRAITS = [
  'intent_seriousness', 'exclusivity_pref', 'pace_fast', 'longterm_plan_openness', 'intent_clarity',
  'honesty_transparency', 'autonomy_need', 'togetherness_need', 'family_importance', 'ambition_career', 'generosity',
  'emotional_expressiveness', 'conflict_directness', 'repair_after_conflict', 'attachment_security_proxy',
  'reassurance_need', 'playfulness_humor',
  'sociability', 'outdoor_activity', 'homebody', 'spontaneity', 'travel_importance', 'alcohol_social_comfort',
  'intellectual_curiosity', 'culture_art_interest', 'orderliness', 'risk_tolerance', 'spirituality_openness',
  'pets_comfort', 'urban_preference', 'night_owl', 'physical_affection_importance',
] as const;

export const SAFETY_TRAITS = [
  'safety_non_aggression',
  'safety_boundary_respect',
  'safety_consent_respect',
  'safety_non_coercion',
  'safety_accountability',
  'honesty_consistency',
] as const;

export type TraitKey = (typeof VECTOR_TRAITS)[number] | (typeof SAFETY_TRAITS)[number];

export const TRAIT_KEYS: ReadonlySet<string> = new Set([...VECTOR_TRAITS, ...SAFETY_TRAITS]);

export type FsmState =
  | 'ONBOARDING'
  | 'RAPPORT_VALUES'
  | 'STRESS_CONFLICT'
  | 'BOUNDARIES_CONSENT'
  | 'CONSISTENCY'
  | 'SYNTHESIS';

export type EvidenceClass = 'self_declared' | 'sjt_response' | 'consistency' | 'user_correction';
