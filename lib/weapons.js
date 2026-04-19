'use strict';
// ── lib/weapons.js — PUBG internal weapon class name → display name ───────────

const WEAPON_NAMES = {
  // ── Assault Rifles ──────────────────────────────────────────────────────────
  'WeapSCAR_C':          'SCAR-L',
  'WeapSCAR-L_C':        'SCAR-L',
  WeapAK47_C:            'AKM',
  WeapM416_C:            'M416',
  WeapHK416_C:           'M416',
  WeapM16A4_C:           'M16A4',
  WeapQBZ_C:             'QBZ-95',
  WeapQBZ95_C:           'QBZ-95',
  WeapG36C_C:            'G36C',
  WeapMk47Mutant_C:      'Mk47 Mutant',
  WeapFamas_C:           'FAMAS',
  WeapFamasG2_C:         'FAMAS G2',
  WeapK2_C:              'K2',
  WeapAUG_C:             'AUG A3',
  WeapGroza_C:           'Groza',
  WeapACE32_C:           'ACE32',
  WeapBerylM762_C:       'Beryl M762',
  WeapFNFal_C:           'FN FAL',

  // ── Designated Marksman Rifles ──────────────────────────────────────────────
  WeapSKS_C:             'SKS',
  BS_WeapSKS_C:          'SKS',
  WeapMini14_C:          'Mini-14',
  WeapSLR_C:             'SLR',
  WeapMk14_C:            'Mk14 EBR',
  BS_WeapMk14_C:         'Mk14 EBR',
  WeapMk12_C:            'Mk12 SPR',
  WeapQBU_C:             'QBU-88',
  WeapDragunov_C:        'SVD',
  WeapVSS_C:             'VSS',

  // ── Sniper Rifles ───────────────────────────────────────────────────────────
  WeapKar98k_C:          'Kar98k',
  WeapM24_C:             'M24',
  BS_WeapM24_C:          'M24',
  WeapAWM_C:             'AWM',
  WeapMosinNagant_C:     'Mosin-Nagant',
  WeapLynxAMR_C:         'Lynx AMR',
  WeapWinchester_C:      'Win94',
  WeapL6_C:              'L6 (AUGA3 sniper)',

  // ── SMGs ────────────────────────────────────────────────────────────────────
  WeapUMP_C:             'UMP45',
  WeapVector_C:          'Vector',
  WeapPP19_C:            'PP-19 Bizon',
  WeapBizonPP19_C:       'PP-19 Bizon',
  WeapMP5K_C:            'MP5K',
  WeapThompson_C:        'Tommy Gun',
  BS_WeapThompson_C:     'Tommy Gun',
  WeapMP9_C:             'MP9',
  WeapMp9_C:             'MP9',
  WeapP90_C:             'P90',
  WeapUZI_C:             'Micro UZI',
  WeapJS9_C:             'JS9',
  'Weapvz61Skorpion_C':  'Skorpion',

  // ── LMGs ────────────────────────────────────────────────────────────────────
  WeapM249_C:            'M249',
  WeapDP28_C:            'DP-28',
  WeapMG3_C:             'MG3',
  BS_WeapMG3_C:          'MG3',

  // ── Shotguns ─────────────────────────────────────────────────────────────────
  WeapBerreta686_C:      'S686',
  WeapSawnOff_C:         'Sawed-Off',
  WeapSawnoff_C:         'Sawed-Off',
  WeapS12K_C:            'S12K',
  WeapSaiga12_C:         'S12K',
  WeapS1897_C:           'S1897',
  WeapDBS_C:             'DBS',
  WeapOriginS12_C:       'O12',

  // ── Pistols ─────────────────────────────────────────────────────────────────
  WeapG18_C:             'P18C (Glock)',
  WeapP1911_C:           'P1911',
  WeapM1911_C:           'P1911',
  WeapP92_C:             'P92',
  WeapM9_C:              'P92',
  BS_WeapM9_C:           'P92',
  WeapR1895_C:           'R1895',
  WeapR45_C:             'R45',
  WeapDesertEagle_C:     'Deagle',

  // ── Special / Turret ────────────────────────────────────────────────────────
  WeapTurret_Super_C:    'Mounted Turret',
  WeapSignatureWeapon_C_C: 'Signature Weapon',
  PanzerFaust100M_Projectile_C: 'Panzerfaust',

  // ── Crossbow ────────────────────────────────────────────────────────────────
  WeapCrossbow_C:        'Crossbow',

  // ── Melee ───────────────────────────────────────────────────────────────────
  WeapCrowbar_C:         'Crowbar',
  WeapPan_C:             'Pan',
  WeapMachete_C:         'Machete',
  WeapSickle_C:          'Sickle',

  // ── Throwables ──────────────────────────────────────────────────────────────
  WeapFragGrenade_C:     'Frag Grenade',
  ProjGrenade_C:         'Frag Grenade',
  WeapSmoke_C:           'Smoke Grenade',
  WeapMolotov_C:         'Molotov',
  WeapV9MolotovCocktail_C: 'Molotov',
  WeapFlashbang_C:       'Flashbang',
  WeapC4_C:              'C4',
  ProjC4_C:              'C4',
  WeapStickyBomb_C:      'Sticky Bomb',
  WeapDecoyGrenade_C:    'Decoy Grenade',
};

// Class names that are not real weapons (vehicles, zones, AI pawns, etc.)
const IGNORE_PATTERNS = [
  /^UltAIPawn/i,
  /BluezoneCustom/i,
  /Bluezonebomb/i,
  /RedZone/i,
  /DrowningDamage/i,
  /FallDamage/i,
  /WeapBullet/i,
  /^Bp_/i,
  /^Buggy_/i,
  /^Dacia_/i,
  /^Uaz_/i,
  /^PlayerFemale/i,
  /^PlayerMale/i,
  /^None$/i,
];

function weaponDisplayName(internalName) {
  if (!internalName) return null;
  if (WEAPON_NAMES[internalName]) return WEAPON_NAMES[internalName];
  // Strip trailing _C and humanize unknown names
  return internalName.replace(/^Weap/, '').replace(/_C$/, '').replace(/_/g, ' ');
}

function isIgnoredCauser(name) {
  if (!name) return true;
  return IGNORE_PATTERNS.some(p => p.test(name));
}

module.exports = { WEAPON_NAMES, weaponDisplayName, isIgnoredCauser };
