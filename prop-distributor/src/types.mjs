// Prop type declarations: footprint half-extents, slope/material rules, declared spacing.
// Spacing values are EDGE-TO-EDGE minima in meters, checked against oriented footprints.

export const TYPES = {
  tree:  { label: '树',   hx: 0.85, hz: 0.85, scale: [0.85, 1.4], slopeMax: 22, height: 4.2, color: '#2e7d32' },
  rock:  { label: '岩石', hx: 0.70, hz: 0.52, scale: [0.6, 1.7],  slopeMax: 40, height: 0.9, color: '#8d8d93' },
  bush:  { label: '灌木', hx: 0.50, hz: 0.50, scale: [0.7, 1.35], slopeMax: 30, height: 0.7, color: '#558b2f' },
  decor: { label: '装饰', hx: 0.34, hz: 0.34, scale: [0.8, 1.45], slopeMax: 25, height: 0.5, color: '#b08d57' },
};

export const TYPE_ORDER = ['tree', 'rock', 'bush', 'decor']; // large first: better packing

// Declared minimum edge-to-edge gap per type pair (meters).
const SPACING_TABLE = {
  'tree|tree': 5.0, 'tree|rock': 2.0, 'tree|bush': 2.0, 'tree|decor': 2.0,
  'rock|rock': 1.2, 'rock|bush': 0.8, 'rock|decor': 0.8,
  'bush|bush': 0.6, 'bush|decor': 0.5,
  'decor|decor': 0.4,
};

export function declaredSpacing(a, b) {
  const k = a < b ? `${a}|${b}` : `${b}|${a}`;
  return SPACING_TABLE[k] ?? 0.5;
}

export function spacingPairs() {
  return Object.entries(SPACING_TABLE).map(([k, v]) => { const [a, b] = k.split('|'); return { a, b, gap: v }; });
}

// Material affinity multipliers for the density field.
export const MATERIAL_MULT = {
  tree:  { meadow: 1.0, forest: 1.6, rock: 0.05, sand: 0.3 },
  rock:  { meadow: 0.7, forest: 0.8, rock: 1.8,  sand: 0.6 },
  bush:  { meadow: 1.2, forest: 1.2, rock: 0.2,  sand: 0.5 },
  decor: { meadow: 1.0, forest: 1.0, rock: 0.8,  sand: 1.2 },
};

export const MATERIAL_COLORS = {
  meadow: '#4a7c3a', forest: '#2f5d2a', rock: '#6f6f74', sand: '#b3a06b',
};
