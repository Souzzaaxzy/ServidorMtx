// ── Nickname effects catalog (NAME_EFFECT) ────────────────────
// The official, server-owned effects catalog. The app NEVER hardcodes which
// effects exist or how they render — it renders whatever this catalog
// returns. `config` is the JSON render contract consumed by the app's
// NicknameRenderer: which animation to run, its intensity/speed, whether it
// spawns particles, and (for color effects) the gradient palette. Effects
// are free (price 0): equipping validates id/active/type only.
//
// Effects are FULLY independent from name colors — any nameColorId combines
// with any nameEffectId; there are no fixed combos and no restrictions.

export interface NameEffectSeed {
  id: string;
  name: string;
  category: string;
  rarity: 'COMMON' | 'UNCOMMON' | 'RARE' | 'EPIC' | 'LEGENDARY';
  config: Record<string, unknown>;
}

type EffectConfig = {
  animation: string;
  intensity: number;
  speed: number;
  particles: boolean;
  colors?: string[];
};

const cfg = (
  animation: string,
  intensity: number,
  speed: number,
  particles: boolean,
  colors?: string[],
): EffectConfig => ({ animation, intensity, speed, particles, ...(colors ? { colors } : {}) });

export const NAME_EFFECTS: NameEffectSeed[] = [
  // ✨ Glow — soft light around the letters.
  { id: 'glow', name: 'Glow', category: 'glow', rarity: 'COMMON', config: cfg('glow', 0.5, 1, false) },
  { id: 'soft_glow', name: 'Soft Glow', category: 'glow', rarity: 'COMMON', config: cfg('glow', 0.25, 1, false) },
  { id: 'intense_glow', name: 'Intense Glow', category: 'glow', rarity: 'COMMON', config: cfg('glow', 0.9, 1, false) },
  { id: 'star_glow', name: 'Star Glow', category: 'glow', rarity: 'RARE', config: cfg('glow', 0.6, 1, true) },
  { id: 'neon_glow', name: 'Neon Glow', category: 'glow', rarity: 'COMMON', config: cfg('neon', 0.7, 1, false) },
  { id: 'crystal_glow', name: 'Crystal Glow', category: 'glow', rarity: 'RARE', config: cfg('crystal', 0.6, 0.8, false) },
  { id: 'electric_glow', name: 'Electric Glow', category: 'glow', rarity: 'RARE', config: cfg('glow', 0.7, 1.4, true) },
  { id: 'fire_glow', name: 'Fire Glow', category: 'glow', rarity: 'COMMON', config: cfg('glow', 0.7, 1.1, false, ['#FF6D00', '#FF1744']) },
  { id: 'ice_glow', name: 'Ice Glow', category: 'glow', rarity: 'COMMON', config: cfg('glow', 0.6, 0.7, false, ['#84FFFF', '#1E88E5']) },
  { id: 'cosmic_glow', name: 'Cosmic Glow', category: 'glow', rarity: 'EPIC', config: cfg('glow', 0.6, 0.9, true) },

  // ⚡ Animated — motion and pulsing light.
  { id: 'pulse', name: 'Pulse', category: 'animated', rarity: 'COMMON', config: cfg('pulse', 0.6, 1, false) },
  { id: 'breathing', name: 'Breathing', category: 'animated', rarity: 'COMMON', config: cfg('pulse', 0.3, 0.5, false) },
  { id: 'shimmer', name: 'Shimmer', category: 'animated', rarity: 'COMMON', config: cfg('shimmer', 0.5, 1, false) },
  { id: 'sparkle', name: 'Sparkle', category: 'animated', rarity: 'COMMON', config: cfg('sparkle', 0.5, 1, true) },
  { id: 'electric', name: 'Electric', category: 'animated', rarity: 'RARE', config: cfg('electric', 0.7, 1.3, true) },
  { id: 'flicker', name: 'Flicker', category: 'animated', rarity: 'COMMON', config: cfg('flicker', 0.4, 1, false) },
  { id: 'neon_pulse', name: 'Neon Pulse', category: 'animated', rarity: 'RARE', config: cfg('pulse', 0.8, 1.2, false) },
  { id: 'wave', name: 'Wave', category: 'animated', rarity: 'COMMON', config: cfg('wave', 0.5, 1, false) },
  { id: 'float', name: 'Float', category: 'animated', rarity: 'COMMON', config: cfg('float', 0.4, 0.8, false) },
  { id: 'rainbow_cycle', name: 'Rainbow Cycle', category: 'animated', rarity: 'EPIC', config: cfg('rainbow_cycle', 0.7, 1, false, ['#FF5252', '#FF9100', '#FFEA00', '#76FF03', '#00E5FF', '#2979FF', '#B388FF']) },

  // 👾 Glitch — digital distortion.
  { id: 'glitch', name: 'Glitch', category: 'glitch', rarity: 'RARE', config: cfg('glitch', 0.5, 1, false) },
  { id: 'digital_glitch', name: 'Digital Glitch', category: 'glitch', rarity: 'RARE', config: cfg('glitch', 0.6, 1.2, false) },
  { id: 'screen_glitch', name: 'Screen Glitch', category: 'glitch', rarity: 'RARE', config: cfg('screen_glitch', 0.6, 1, false) },
  { id: 'error', name: 'Error', category: 'glitch', rarity: 'RARE', config: cfg('glitch', 0.8, 1.4, false, ['#FF1744']) },
  { id: 'corrupted', name: 'Corrupted', category: 'glitch', rarity: 'EPIC', config: cfg('corrupted', 0.7, 1, false) },
  { id: 'rgb_glitch', name: 'RGB Glitch', category: 'glitch', rarity: 'RARE', config: cfg('rgb_glitch', 0.6, 1, false, ['#FF0000', '#00FF00', '#0000FF']) },
  { id: 'chromatic_glitch', name: 'Chromatic Glitch', category: 'glitch', rarity: 'RARE', config: cfg('chromatic', 0.5, 1, false) },
  { id: 'signal_lost', name: 'Signal Lost', category: 'glitch', rarity: 'EPIC', config: cfg('signal_lost', 0.8, 1.5, false) },
  { id: 'digital_noise', name: 'Digital Noise', category: 'glitch', rarity: 'RARE', config: cfg('noise', 0.6, 1.2, true) },
  { id: 'cyber_glitch', name: 'Cyber Glitch', category: 'glitch', rarity: 'EPIC', config: cfg('glitch', 0.7, 1.2, true, ['#00E5FF', '#B388FF']) },

  // 🌈 Color — animated hue transitions (independent of the base color).
  { id: 'rainbow', name: 'Rainbow', category: 'color', rarity: 'EPIC', config: cfg('gradient_cycle', 0.7, 1, false, ['#FF5252', '#FF9100', '#FFEA00', '#76FF03', '#00E5FF', '#2979FF', '#B388FF']) },
  { id: 'color_shift', name: 'Color Shift', category: 'color', rarity: 'COMMON', config: cfg('hue_shift', 0.5, 0.8, false) },
  { id: 'hue_shift', name: 'Hue Shift', category: 'color', rarity: 'COMMON', config: cfg('hue_shift', 0.7, 1, false) },
  { id: 'blue_cyan', name: 'Blue → Cyan', category: 'color', rarity: 'COMMON', config: cfg('gradient_cycle', 0.6, 1, false, ['#1E88E5', '#00E5FF']) },
  { id: 'purple_pink', name: 'Purple → Pink', category: 'color', rarity: 'COMMON', config: cfg('gradient_cycle', 0.6, 1, false, ['#8E24AA', '#EC407A']) },
  { id: 'red_orange', name: 'Red → Orange', category: 'color', rarity: 'COMMON', config: cfg('gradient_cycle', 0.6, 1, false, ['#E53935', '#FB8C00']) },
  { id: 'cyan_blue', name: 'Cyan → Blue', category: 'color', rarity: 'COMMON', config: cfg('gradient_cycle', 0.6, 1, false, ['#00ACC1', '#1E88E5']) },
  { id: 'purple_blue', name: 'Purple → Blue', category: 'color', rarity: 'COMMON', config: cfg('gradient_cycle', 0.6, 1, false, ['#8E24AA', '#1E88E5']) },
  { id: 'green_cyan', name: 'Green → Cyan', category: 'color', rarity: 'COMMON', config: cfg('gradient_cycle', 0.6, 1, false, ['#43A047', '#00ACC1']) },
  { id: 'sunset', name: 'Sunset', category: 'color', rarity: 'RARE', config: cfg('gradient_cycle', 0.7, 0.9, false, ['#E53935', '#FB8C00', '#EC407A', '#8E24AA']) },

  // 🔥 Elemental — fire, ice, lightning and friends.
  { id: 'fire', name: 'Fire', category: 'elemental', rarity: 'RARE', config: cfg('fire', 0.7, 1, true, ['#FF6D00', '#FF1744', '#FFEA00']) },
  { id: 'burning', name: 'Burning', category: 'elemental', rarity: 'RARE', config: cfg('fire', 0.9, 1.2, true, ['#FF3D00', '#DD2C00']) },
  { id: 'flame', name: 'Flame', category: 'elemental', rarity: 'RARE', config: cfg('fire', 0.6, 1.4, false, ['#FF9100', '#FFEA00']) },
  { id: 'ice', name: 'Ice', category: 'elemental', rarity: 'RARE', config: cfg('ice', 0.6, 0.8, true, ['#84FFFF', '#1E88E5']) },
  { id: 'frozen', name: 'Frozen', category: 'elemental', rarity: 'RARE', config: cfg('ice', 0.5, 0.5, false, ['#B2EBF2', '#4DD0E1']) },
  { id: 'lightning', name: 'Lightning', category: 'elemental', rarity: 'EPIC', config: cfg('electric', 0.9, 1.5, true, ['#FFEA00', '#84FFFF']) },
  { id: 'water', name: 'Water', category: 'elemental', rarity: 'RARE', config: cfg('wave', 0.6, 1, false, ['#1E88E5', '#00ACC1']) },
  { id: 'wind', name: 'Wind', category: 'elemental', rarity: 'RARE', config: cfg('wind', 0.5, 1.2, true) },
  { id: 'shadow', name: 'Shadow', category: 'elemental', rarity: 'RARE', config: cfg('shadow', 0.6, 1, false) },
  { id: 'meteor', name: 'Meteor', category: 'elemental', rarity: 'EPIC', config: cfg('meteor', 0.7, 1.1, true, ['#FF6D00', '#FFD740']) },
  { id: 'lava', name: 'Lava', category: 'elemental', rarity: 'EPIC', config: cfg('lava', 0.8, 0.7, true, ['#DD2C00', '#FF9100']) },
  { id: 'cosmic', name: 'Cosmic', category: 'elemental', rarity: 'EPIC', config: cfg('cosmic', 0.6, 0.9, true) },

  // 💎 Premium — high-end reflections and particles.
  { id: 'diamond', name: 'Diamond', category: 'premium', rarity: 'LEGENDARY', config: cfg('crystal', 0.8, 1, true, ['#B9F6CA', '#84FFFF', '#FFFFFF']) },
  { id: 'royal', name: 'Royal', category: 'premium', rarity: 'LEGENDARY', config: cfg('glow', 0.7, 0.8, false, ['#D4AF37', '#8E24AA']) },
  { id: 'luxury', name: 'Luxury', category: 'premium', rarity: 'LEGENDARY', config: cfg('shimmer', 0.8, 0.9, false, ['#D4AF37', '#FFFFFF']) },
  { id: 'golden', name: 'Golden', category: 'premium', rarity: 'LEGENDARY', config: cfg('shimmer', 0.7, 1, false, ['#D4AF37', '#FFC107']) },
  { id: 'holographic', name: 'Holographic', category: 'premium', rarity: 'LEGENDARY', config: cfg('holographic', 0.7, 1, false, ['#84FFFF', '#B388FF', '#FF80AB']) },
  { id: 'galaxy', name: 'Galaxy', category: 'premium', rarity: 'LEGENDARY', config: cfg('cosmic', 0.8, 0.8, true, ['#2979FF', '#B388FF', '#FF80AB']) },
  { id: 'stardust', name: 'Stardust', category: 'premium', rarity: 'LEGENDARY', config: cfg('sparkle', 0.7, 1, true, ['#FFEA00', '#FFFFFF']) },
  { id: 'aurora', name: 'Aurora', category: 'premium', rarity: 'LEGENDARY', config: cfg('aurora', 0.7, 0.8, false, ['#76FF03', '#00E5FF', '#B388FF']) },
  { id: 'cosmic_premium', name: 'Cosmic Premium', category: 'premium', rarity: 'LEGENDARY', config: cfg('cosmic', 0.9, 1, true, ['#B388FF', '#84FFFF']) },
  { id: 'celestial', name: 'Celestial', category: 'premium', rarity: 'LEGENDARY', config: cfg('glow', 0.8, 0.7, true, ['#FFFFFF', '#FFF9C4']) },

  // 🧬 Cyberpunk — technological aesthetic.
  { id: 'cyber', name: 'Cyber', category: 'cyberpunk', rarity: 'EPIC', config: cfg('neon', 0.7, 1.1, false, ['#00E5FF', '#76FF03']) },
  { id: 'digital', name: 'Digital', category: 'cyberpunk', rarity: 'EPIC', config: cfg('noise', 0.5, 1, true, ['#00E676', '#00E5FF']) },
  { id: 'matrix', name: 'Matrix', category: 'cyberpunk', rarity: 'EPIC', config: cfg('code', 0.7, 1, true, ['#00E676', '#0066FF']) },
  { id: 'energy', name: 'Energy', category: 'cyberpunk', rarity: 'EPIC', config: cfg('energy', 0.7, 1.2, false, ['#76FF03', '#00E5FF']) },
  { id: 'cyber_energy', name: 'Cyber Energy', category: 'cyberpunk', rarity: 'EPIC', config: cfg('energy', 0.9, 1.3, true, ['#00E5FF', '#B388FF']) },
  { id: 'hologram', name: 'Hologram', category: 'cyberpunk', rarity: 'EPIC', config: cfg('holographic', 0.6, 1, false, ['#84FFFF', '#00E5FF']) },
  { id: 'code', name: 'Code', category: 'cyberpunk', rarity: 'EPIC', config: cfg('code', 0.6, 1.1, true, ['#00E676']) },
  { id: 'scanline', name: 'Scanline', category: 'cyberpunk', rarity: 'EPIC', config: cfg('scanline', 0.5, 1, false) },
  { id: 'cyber_wave', name: 'Cyber Wave', category: 'cyberpunk', rarity: 'EPIC', config: cfg('wave', 0.7, 1.2, false, ['#00E5FF', '#2979FF']) },
  { id: 'cyber_pulse', name: 'Cyber Pulse', category: 'cyberpunk', rarity: 'EPIC', config: cfg('pulse', 0.8, 1.3, false, ['#00E5FF', '#76FF03']) },

  // 🌑 Dark — shadows and void energy.
  { id: 'dark_shadow', name: 'Dark Shadow', category: 'dark', rarity: 'EPIC', config: cfg('shadow', 0.8, 0.9, false) },
  { id: 'dark_aura', name: 'Dark Aura', category: 'dark', rarity: 'EPIC', config: cfg('glow', 0.7, 0.8, false, ['#4A148C', '#212121']) },
  { id: 'void', name: 'Void', category: 'dark', rarity: 'EPIC', config: cfg('void', 0.8, 0.8, false) },
  { id: 'abyss', name: 'Abyss', category: 'dark', rarity: 'EPIC', config: cfg('void', 0.9, 0.6, false, ['#0D47A1', '#000000']) },
  { id: 'blood', name: 'Blood', category: 'dark', rarity: 'EPIC', config: cfg('glow', 0.7, 0.9, false, ['#6B0000', '#8E0000']) },
  { id: 'dark_glitch', name: 'Dark Glitch', category: 'dark', rarity: 'EPIC', config: cfg('glitch', 0.7, 1, false, ['#4A148C', '#212121']) },
  { id: 'phantom', name: 'Phantom', category: 'dark', rarity: 'EPIC', config: cfg('ghost', 0.6, 1, true) },
  { id: 'darkness', name: 'Darkness', category: 'dark', rarity: 'EPIC', config: cfg('shadow', 0.9, 0.7, true) },
  { id: 'eclipse', name: 'Eclipse', category: 'dark', rarity: 'EPIC', config: cfg('eclipse', 0.7, 0.8, false) },
  { id: 'blackout', name: 'Blackout', category: 'dark', rarity: 'EPIC', config: cfg('flicker', 0.9, 0.9, false) },

  // 🎭 Visual — misc visual flair.
  { id: 'motion', name: 'Motion', category: 'visual', rarity: 'COMMON', config: cfg('motion', 0.5, 1.2, false) },
  { id: 'spark', name: 'Spark', category: 'visual', rarity: 'COMMON', config: cfg('sparkle', 0.4, 1.1, true) },
  { id: 'smoke', name: 'Smoke', category: 'visual', rarity: 'COMMON', config: cfg('smoke', 0.5, 0.7, true) },
  { id: 'distortion', name: 'Distortion', category: 'visual', rarity: 'RARE', config: cfg('distortion', 0.4, 1, false) },
  { id: 'ghost', name: 'Ghost', category: 'visual', rarity: 'RARE', config: cfg('ghost', 0.5, 1, false) },
  { id: 'reflection', name: 'Reflection', category: 'visual', rarity: 'COMMON', config: cfg('shimmer', 0.4, 0.9, false) },
];
