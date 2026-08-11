/**
 * parser.js — Tales of Vesperia: Definitive Edition save file parser.
 *
 * PC format: TO8SAVE magic at offset 0x228. TOVR addresses are relative to 0x228.
 */

'use strict';

const TOVR = 0x228;
const FILE_SIZE = 838872;
const MAGIC_OFFSET = TOVR;
const MAGIC = 'TO8SAVE';

// ─── Names database ─────────────────────────────────────────────

const MEMBERS = {
  1: 'Yuri Lowell', 2: 'Repede', 3: 'Judith',
  4: 'Karol Capel', 5: 'Patty Fleur', 6: 'Flynn Scifo',
  7: 'Raven', 8: 'Rita Mordio', 9: 'Estellise',
};

// Built from ToV game data — tool/consumable items
const ITEM_NAMES = {
  0: '---(empty)---',
  1: 'Apple Gel', 2: 'Lemon Gel', 3: 'Orange Gel', 4: 'Pineapple Gel',
  5: 'Miracle Gel', 6: 'Melon Gel', 7: 'Treat', 8: 'Specific',
  9: 'Panacea Bottle', 10: 'Life Bottle', 11: 'Holy Bottle',
  12: 'Dark Bottle', 13: 'Magic Lens', 14: 'Syrup Bottle',
  15: 'All-Divide', 16: 'Hourglass', 17: 'Tent',
  18: 'Pancake', 19: 'Rice Ball', 20: 'Miso Soup',
  21: 'Lunch Box', 22: 'Chicken', 23: 'Steak',
  24: 'Sushi', 25: 'Curry', 26: 'Fruit Juice',
  27: 'Milk', 28: 'Coffee', 29: 'Tea',
  30: 'Oden', 31: 'Pudding', 32: 'Cake',
  33: 'Ice Cream', 34: 'Fruit Parfait', 35: 'Ramen',
  // Weapons start at 50+
  // Armor 550+
  // Accessories 1050+
  // Materials 1375+
};

// Per-character skill names — bit positions match the internal game ordering
// Extracted from Aselia Wiki skill lists (Attack → Guard → Move → Support order)
const SKILL_NAMES = {
  // ── Yuri Lowell (member 1) ──
  1: {
    // Attack
    0:'Strength',1:'Strength 2',2:'Strength 3',3:'Strength 4',4:'Magic',5:'Magic 2',6:'Magic 3',
    7:'Rise Attack',8:'Heavy Hit',9:'Swords Up',10:'Axes Up',11:'Assassin',
    12:'Combo Plus',13:'Combo Plus 2',14:'Combo Plus 3',15:'Step Combo',16:'Dragon Buster',
    17:'Combo Voltage',18:'Combination',19:'Combination 2',20:'Combination 3',
    21:'High Tension',22:'Hyper Tension',23:'Ultimate Tension',24:'Cross Counter',25:'Reflect',
    26:'FS Bonus',27:'FS Bonus 2',28:'BA Force',29:'Special',30:'Hit Plus',
    31:'HP Condition',32:'HP Condition 2',33:'Chain',34:'Hell Fire',35:'One Man Show',
    36:'Half Damage',37:'Quarter Damage',38:'Minimum Damage',39:'Elemental',
    40:'Perfect Tension',41:'Fatal Exceed',42:'Burst Hold',
    // Guard
    43:'Defend',44:'Defend 2',45:'Defend 3',46:'Resist',47:'Resist 2',48:'Resist 3',
    49:'Critical Guard',50:'Magic Guard',51:'Guard Plus',52:'Magic Guard Plus',53:'Guard Reflect',
    54:'Guard Artes',55:'Roll',56:'Anti Element',57:'Status Guard',58:'Condition Guard',59:'Immunity',
    60:'Endure',61:'Void Attack',62:'Void Magic',63:'Step Away',64:'Defend Artes',65:'Glory',
    66:'TP Condition',67:'TP Condition 2',68:'TP Condition 3',69:'TP Condition 4',
    70:'Crucible',71:'Athenor',72:'Burst Guard',73:'Recovering Guard',74:'OVL Concentrate',
    // Move
    75:'Evade',76:'Evade 2',77:'Evade 3',78:'Item Thrower',79:'Item Pro',80:'Backstep',
    81:'Landing Step',82:'Recover',83:'Combo Force',84:'Aerial Combo',
    85:'Super Chain 4',86:'Super Chain 5',87:'Super Chain',88:'Super Chain 2',89:'Super Chain 3',
    90:'Ability Plus',91:'High Ability Plus',92:'Hyper Ability Plus',93:'O.L. Boost',
    94:'Fatal Finish',95:'Fatal Finish Plus',96:'Alembic',97:'Gale',98:'Link Slash',
    // Support
    99:'Vitality',100:'Vitality 2',101:'Vitality 3',102:'Spirits',103:'Spirits 2',104:'Spirits 3',
    105:'HP Recover',106:'TP Recover',107:'Rebirth',108:'Rebirth 2',109:'Lucky Soul',110:'Stat Boost',
    111:'Resurrect',112:'Loner',113:'OVL Bonus',114:'OVL Bonus 2',
    115:'Taunt',116:'Taunt 2',117:'OVL Taunt',118:'OVL Taunt 2',
    119:'Dispersion',120:'Great Deluge',121:'Bastion',
    122:'Life Healer',123:'Spirit Healer',124:'Life Up',125:'Mental Up',
    126:'Happiness',127:'Happiness 2',128:'Happiness 3',129:'EXP Share',
    130:'OVL Plus',131:'OVL Team',132:'OVL Team 2',133:'OVL Team 3',134:'Stand Alone',
  },
  // ── Repede (member 2) ──
  2: {
    // Attack
    0:'Strength',1:'Strength 2',2:'Strength 3',3:'Magic',4:'Magic 2',5:'Magic 3',
    6:'Rise Attack',7:'Heavy Hit',8:'Elemental',9:'Steal Plus',10:'Combo Plus',
    11:'Cross Counter',12:'Reflect',13:'FS Bonus',14:'FS Bonus 2',
    15:'Hunter\'s Fang',16:'BA Force',17:'Lucky Limit',18:'Special',
    19:'HP Condition',20:'HP Condition 2',21:'Chain',22:'Hell Fire',
    23:'Half Damage',24:'Quarter Damage',25:'Minimum Damage',26:'Fatal Exceed',27:'Burst Hold',
    // Guard
    28:'Defend',29:'Defend 2',30:'Defend 3',31:'Resist',32:'Resist 2',33:'Resist 3',
    34:'Critical Guard',35:'Magic Guard',36:'Guard Plus',37:'Magic Guard Plus',38:'Guard Reflect',
    39:'Guard Artes',40:'Roll',41:'Anti Element',42:'Status Guard',43:'Condition Guard',44:'Immunity',
    45:'Endure',46:'Void Attack',47:'Void Magic',48:'Step Away',49:'Mobile Armor',
    50:'TP Condition',51:'TP Condition 2',52:'TP Condition 3',53:'TP Condition 4',
    54:'Crucible',55:'Athenor',56:'Burst Guard',57:'Recovering Guard',58:'OVL Concentrate',
    // Move
    59:'Evade',60:'Evade 2',61:'Evade 3',62:'Evade 4',63:'Item Thrower',64:'Item Pro',
    65:'Item Pro 2',66:'Speedy Item',67:'Backstep',68:'Recover',
    69:'Dash',70:'Dash Cancel',71:'Quick Turn',72:'Runners',73:'Runners 2',
    74:'Combo Force',75:'Aerial Combo',76:'Super Chain 4',77:'Super Chain 5',
    78:'O.L. Boost',79:'Double Appeal',80:'Speed Up',81:'Speed Up 2',82:'High Mobility',
    83:'Alembic',84:'Gale',85:'Holy Breath',86:'Dark Breath',87:'Encounter Bonus',
    // Support
    88:'Vitality',89:'Vitality 2',90:'Vitality 3',91:'Spirits',92:'Spirits 2',93:'Spirits 3',
    94:'Luck Plus',95:'Luck Plus 2',96:'Item Pro 2',97:'Item Amplifier',98:'Item Amplifier 2',
    99:'Lucky Item',100:'Multi-Item',101:'Full Check',102:'Scanning',103:'Inspector',
    104:'HP Recover',105:'TP Recover',106:'Rebirth',107:'Rebirth 2',108:'Lucky Soul',109:'Stat Boost',
    110:'Lucky Call',111:'Resurrect',112:'OVL Bonus',113:'OVL Bonus 2',
    114:'OVL Plus',115:'OVL Plus 2',116:'Taunt',117:'Taunt 2',118:'OVL Taunt',119:'OVL Taunt 2',
    120:'Bark',121:'Dispersion',122:'Great Deluge',
    123:'Life Healer',124:'Spirit Healer',125:'Life Up',126:'Mental Up',
    127:'Happiness',128:'Happiness 2',129:'Happiness 3',130:'EXP Share',
    131:'Treasure Fangs',132:'Stand Alone',
  },
  // ── Judith (member 3) ──
  3: {
    // Attack
    0:'Strength',1:'Strength 2',2:'Strength 3',3:'Magic',4:'Magic 2',5:'Magic 3',
    6:'Rise Attack',7:'Heavy Hit',8:'Aerial Force',9:'Elemental',
    10:'Aerial Artes',11:'Aerial Artes 2',12:'Aerial Artes 3',13:'Aerial Finish',
    14:'High Combo',15:'Combo Plus',16:'Cross Counter',17:'Reflect',
    18:'FS Bonus',19:'FS Bonus 2',20:'BA Force',21:'Special',
    22:'HP Condition',23:'HP Condition 2',24:'Chain',25:'Hell Fire',
    26:'Half Damage',27:'Quarter Damage',28:'Minimum Damage',
    29:'High Aerial Tension',30:'Hyper Aerial Tension',31:'Fatal Exceed',32:'Burst Hold',
    // Guard
    33:'Defend',34:'Defend 2',35:'Defend 3',36:'Resist',37:'Resist 2',38:'Resist 3',
    39:'Critical Guard',40:'Magic Guard',41:'Aerial Guard',42:'Aerial Magic Guard',
    43:'Guard Plus',44:'Magic Guard Plus',45:'Guard Reflect',46:'Guard Artes',47:'Roll',
    48:'Anti Element',49:'Status Guard',50:'Condition Guard',51:'Immunity',
    52:'Endure',53:'Void Attack',54:'Void Magic',55:'Step Away',56:'Aerial Armor',57:'Escape Jump',
    58:'TP Condition',59:'TP Condition 2',60:'TP Condition 3',61:'TP Condition 4',
    62:'Crucible',63:'Athenor',64:'Spear Master',65:'Rod Master',
    66:'Burst Guard',67:'Recovering Guard',68:'OVL Concentrate',
    // Move
    69:'Evade',70:'Evade 2',71:'Evade 3',72:'Item Thrower',73:'Item Pro',
    74:'Backstep',75:'Recover',76:'Recovery Artes',
    77:'Aerial Jump',78:'Aerial Jump 2',79:'Jump Cancel',80:'Aerial OVL',
    81:'Aerial Step',82:'Aerial Dash',83:'Touch Down',84:'Landing',
    85:'Combo Force',86:'Aerial Combo',87:'Aerial Combo 2',88:'Aerial Combo 3',
    89:'Super Chain 4',90:'Super Chain 5',91:'O.L. Boost',
    92:'Alembic',93:'Gale',
    94:'Aerial Ability Plus',95:'Aerial High Ability Plus',96:'Aerial Hyper Ability Plus',
    // Support
    97:'Vitality',98:'Vitality 2',99:'Vitality 3',100:'Spirits',101:'Spirits 2',102:'Spirits 3',
    103:'Aerial Tension',104:'HP Recover',105:'TP Recover',
    106:'Rebirth',107:'Rebirth 2',108:'Lucky Soul',109:'Stat Boost',110:'Resurrect',
    111:'Rod Economy',112:'Lucky Spear',113:'OVL Bonus',114:'OVL Bonus 2',
    115:'Taunt',116:'Taunt 2',117:'OVL Taunt',118:'OVL Taunt 2',119:'Temptation',
    120:'Dispersion',121:'Great Deluge',
    122:'Life Healer',123:'Spirit Healer',124:'Life Up',125:'Mental Up',
    126:'Happiness',127:'Happiness 2',128:'Happiness 3',129:'EXP Share',
    130:'OVL Plus',131:'Stand Alone',
  },
  // ── Karol Capel (member 4) ──
  4: {
    // Attack
    0:'Strength',1:'Strength 2',2:'Strength 3',3:'Magic',4:'Magic 2',5:'Magic 3',
    6:'Rise Attack',7:'Heavy Hit',8:'Combatir',9:'Raynard',10:'Bug Busters',
    11:'Second Attack',12:'Critical',13:'Critical Break',14:'Sustained Critical',15:'Elemental',
    16:'Combo Plus',17:'Mighty Charge',18:'Charge Hold',19:'Charge Hold 2',20:'Speed Charge',
    21:'Charge Smash',22:'Attack Arte Charge',
    23:'High Fatal Tension',24:'Hyper Fatal Tension',25:'Cross Counter',26:'Reflect',
    27:'FS Bonus',28:'FS Bonus 2',29:'Fatal Exceed',30:'BA Force',31:'Burst Hold',32:'Special',
    33:'HP Condition',34:'HP Condition 2',35:'Chain',36:'Hell Fire',
    37:'Half Damage',38:'Quarter Damage',39:'Minimum Damage',
    // Guard
    40:'Defend',41:'Defend 2',42:'Defend 3',43:'Resist',44:'Resist 2',45:'Resist 3',
    46:'Critical Guard',47:'Magic Guard',48:'Guard Plus',49:'Magic Guard Plus',
    50:'Guard Reflect',51:'Guard Artes',52:'Roll',53:'Anti Element',54:'Steel Defense',
    55:'Status Guard',56:'Condition Guard',57:'Immunity',
    58:'Endure',59:'Void Attack',60:'Void Magic',61:'Step Away',
    62:'TP Condition',63:'TP Condition 2',64:'TP Condition 3',65:'TP Condition 4',
    66:'Crucible',67:'Athenor',68:'Break Down',69:'Down Hit',70:'Heavy Weight',
    71:'Healing Arte Charge',72:'Burst Guard',73:'Recovering Guard',74:'OVL Concentrate',
    // Move
    75:'Evade',76:'Evade 2',77:'Evade 3',78:'Item Thrower',79:'Item Pro',
    80:'Backstep',81:'Recover',82:'Run',83:'Combo Force',
    84:'Super Chain 4',85:'Super Chain 5',86:'O.L. Boost',
    87:'Taunt & Evade',88:'Taunt Gamble',89:'Member Taunt',
    90:'Alembic',91:'Gale',92:'Motion Change',93:'Play Dead',
    // Support
    94:'Vitality',95:'Vitality 2',96:'Vitality 3',97:'Vitality 4',
    98:'Spirits',99:'Spirits 2',100:'Spirits 3',
    101:'Medical Smash',102:'Eternal Weakness',103:'Support Arte Charge',
    104:'Critical Recover',105:'HP Recover',106:'TP Recover',
    107:'Rebirth',108:'Rebirth 2',109:'Lucky Soul',110:'Stat Boost',111:'Resurrect',
    112:'OVL Bonus',113:'OVL Bonus 2',
    114:'Taunt',115:'Taunt 2',116:'OVL Taunt',117:'OVL Taunt 2',
    118:'Dispersion',119:'Great Deluge',
    120:'Life Healer',121:'Spirit Healer',122:'Life Up',123:'Mental Up',
    124:'Happiness',125:'Happiness 2',126:'Happiness 3',127:'Safety',128:'EXP Share',
    129:'Coward',130:'OVL Plus',131:'Stand Alone',
  },
  // ── Patty Fleur (member 5) ──
  5: {
    // Attack
    0:'Strength',1:'Strength 2',2:'Strength 3',3:'Magic',4:'Magic 2',5:'Magic 3',
    6:'Rise Attack',7:'Heavy Hit',8:'Elemental',9:'Combo Plus',10:'Combo Plus Advance',
    11:'Cross Counter',12:'Safe Bet',13:'Gambler\'s Soul',14:'Critical Hitter',
    15:'Reflect',16:'FS Bonus',17:'FS Bonus 2',18:'Fatal Exceed',
    19:'BA Force',20:'Burst Hold',21:'Limit Fever',22:'Special',
    23:'HP Condition 3',24:'HP Condition 4',25:'Fighting Lens',
    26:'Half Damage',27:'Quarter Damage',28:'Minimum Damage',
    29:'Chain',30:'Hell Fire',
    // Guard
    31:'Defend',32:'Defend 2',33:'Defend 3',34:'Resist',35:'Resist 2',36:'Resist 3',
    37:'Critical Guard',38:'Magic Guard',39:'Guard Plus',40:'Magic Guard Plus',
    41:'Guard Reflect',42:'Guard Artes',43:'Roll',44:'Anti Element',
    45:'Status Guard',46:'Condition Guard',47:'Immunity',
    48:'Endure',49:'Void Attack',50:'Void Magic',51:'Step Away',52:'Defend Artes Advance',
    53:'Burst Guard',54:'Recovering Guard',55:'Brainiac Grace',
    56:'TP Condition',57:'TP Condition 2',58:'TP Condition 3',59:'TP Condition 4',
    60:'OVL Concentrate',61:'Crucible',62:'Athenor',
    // Move
    63:'Evade',64:'Evade 2',65:'Evade 3',66:'Item Thrower',67:'Item Pro',
    68:'Backstep',69:'Step Cancel F',70:'Recover',
    71:'Form Selection',72:'Form Hold',73:'Combo Force',74:'Aerial Combo',
    75:'Brainiac Speed Cast',76:'Super Chain 4',77:'Super Chain 5',
    78:'Brainiac Combo Magic',79:'Brainiac Combo Magic 2',80:'O.L. Boost',
    81:'Critical Upgrade',82:'Critical Upgrade 2',
    83:'High Form Change',84:'Hyper Form Change',
    85:'Advance Ability Plus',86:'Brainiac Magic Combo',87:'Brainiac Magic Selection',
    88:'OVL Gamble',89:'Female Company',90:'Kids\' Association',
    91:'Marksmen\'s Society',92:'Blonde Universe',93:'Dream Couple',94:'Mascot Soul',
    95:'Alembic',96:'Gale',
    // Support
    97:'Vitality',98:'Vitality 2',99:'Vitality 3',100:'Spirits',101:'Spirits 2',102:'Spirits 3',
    103:'HP Recover',104:'TP Recover',105:'Rebirth',106:'Rebirth 2',107:'Lucky Soul',
    108:'Burst Security',109:'Stat Boost',
    110:'OVL Roulette: HP',111:'OVL Roulette: TP',112:'OVL Roulette: OVL',
    113:'Resurrect',114:'Reincarnation',115:'OVL Bonus',116:'OVL Bonus 2',
    117:'Taunt',118:'Taunt 2',119:'OVL Taunt',120:'OVL Taunt 2',
    121:'Life Healer',122:'Spirit Healer',123:'Life Up',124:'Mental Up',
    125:'Happiness',126:'Happiness 2',127:'Happiness 3',128:'EXP Share',
    129:'Sticky Fingers',130:'Stand Alone',131:'Dispersion',132:'Great Deluge',
  },
  // ── Flynn Scifo (member 6) ──
  6: {
    // Attack
    0:'Strength',1:'Strength 2',2:'Strength 3',3:'Magic',4:'Magic 2',5:'Magic 3',
    6:'Rise Attack',7:'Heavy Hit',8:'Rival Surge',9:'Rival Surge 2',10:'Hero',
    11:'Stinger Blow',12:'Elemental',13:'Shine',14:'Combo Plus',
    15:'Cross Counter',16:'Reflect',17:'FS Bonus',18:'FS Bonus 2',
    19:'Fatal Exceed',20:'BA Force',21:'Burst Hold',22:'Special',23:'Team Work',
    24:'HP Condition',25:'HP Condition 2',
    26:'Arte Smash',27:'Magic Smash',28:'Burst Smash',
    29:'Half Damage',30:'Quarter Damage',31:'Minimum Damage',32:'Chain',33:'Hell Fire',
    // Guard
    34:'Defend',35:'Defend 2',36:'Defend 3',37:'Resist',38:'Resist 2',39:'Resist 3',
    40:'Critical Guard',41:'Magic Guard',42:'Guard Plus',43:'Magic Guard Plus',
    44:'Guard Reflect',45:'Guard Artes',46:'Guard Artes 2',47:'Roll',48:'Anti Element',
    49:'Guarding Skill',50:'Status Guard',51:'Condition Guard',52:'Immunity',53:'Lion Heart',
    54:'Cure Area',55:'Guarding Cast',56:'Endure',57:'Void Attack',58:'Void Magic',
    59:'Step Away',60:'Burst Guard',61:'Recovering Guard',
    62:'TP Condition',63:'TP Condition 2',64:'TP Condition 3',65:'TP Condition 4',
    66:'OVL Concentrate',67:'Hyper Guard',68:'Hyper Magic Guard',
    69:'Shield',70:'Magic Shield',71:'Devotion',72:'Energy Coat',
    73:'Crucible',74:'Athenor',
    // Move
    75:'Evade',76:'Evade 2',77:'Evade 3',78:'Just Soul',
    79:'Item Thrower',80:'Item Pro',81:'Backstep',82:'Recover',83:'Combo Force',
    84:'Aerial Combo',85:'Super Chain 4',86:'Super Chain 5',
    87:'Ability Plus',88:'High Ability Plus',89:'Hyper Ability Plus',90:'O.L. Boost',
    91:'OVL Boost Area',92:'S. Spell Area',93:'Alembic',94:'Gale',
    // Support
    95:'Vitality',96:'Vitality 2',97:'Vitality 3',98:'Spirits',99:'Spirits 2',100:'Spirits 3',
    101:'HP Recover',102:'TP Recover',103:'Rebirth',104:'Rebirth 2',105:'Lucky Soul',
    106:'Stat Boost',107:'Resurrect',108:'HP Surge',109:'TP Surge',
    110:'OVL Bonus',111:'OVL Bonus 2',112:'OVL Recover',113:'Natural Recover',
    114:'HP Relax',115:'OVL Relax',
    116:'Taunt',117:'Taunt 2',118:'OVL Taunt',119:'OVL Taunt 2',
    120:'Life Healer',121:'Spirit Healer',122:'Life Up',123:'Mental Up',
    124:'Happiness',125:'Happiness 2',126:'Happiness 3',127:'EXP Share',
    128:'TP Support',129:'No Artes Plus',130:'Stand Alone',
    131:'Dispersion',132:'Great Deluge',
  },
  // ── Raven (member 7) ──
  7: {
    // Attack
    0:'Strength',1:'Strength 2',2:'Strength 3',3:'Strength T',
    4:'Magic',5:'Magic 2',6:'Magic 3',7:'Magic T',
    8:'Rise Attack',9:'Light Force',10:'Hunter',11:'TP Attack',12:'Elemental',13:'Stun Magic',
    14:'Change Style',15:'Change Style 2',16:'Combo Plus',17:'Endless Shot',
    18:'Cross Counter',19:'Reflect',20:'FS Bonus',21:'FS Bonus 2',22:'BA Force',23:'Special',
    24:'HP Condition 3',25:'HP Condition 4',26:'Chain',27:'Hell Fire',
    28:'Half Damage',29:'Quarter Damage',30:'Minimum Damage',
    31:'Bullfight Mind',32:'Fatal Exceed',33:'Burst Hold',
    // Guard
    34:'Defend',35:'Defend 2',36:'Defend 3',37:'Defend T',
    38:'Resist',39:'Resist 2',40:'Resist 3',41:'Resist T',
    42:'Critical Guard',43:'Magic Guard',44:'Guard Plus',45:'Magic Guard Plus',
    46:'Guard Reflect',47:'Guard Artes',48:'Roll',49:'Revenge Arrow',50:'Anti Element',
    51:'Status Guard',52:'Condition Guard',53:'Immunity',
    54:'Endure',55:'Void Attack',56:'Void Magic',57:'Step Away',58:'Escape Step',
    59:'TP Condition',60:'TP Condition 2',61:'TP Condition 3',62:'TP Condition 4',
    63:'Crucible',64:'Athenor',
    65:'Heavy Arrow',66:'Power Shot',67:'Heavy Energy',
    68:'Burst Guard',69:'Recovering Guard',70:'OVL Concentrate',
    // Move
    71:'Evade',72:'Evade 2',73:'Evade 3',74:'Item Thrower',75:'Item Pro',
    76:'In Step',77:'Backstep',78:'Long Step',79:'Step Cancel',80:'Recover',
    81:'Combo Force',82:'Quick Arrow',83:'Long Range',84:'Lucky End',
    85:'Super Chain 4',86:'Super Chain 5',87:'O.L. Boost',88:'High Tension',
    89:'Alembic',90:'Gale',91:'Headhunter',92:'High Taunt',
    // Support
    93:'Vitality',94:'Vitality 2',95:'Vitality 3',96:'Spirits',97:'Spirits 2',98:'Spirits 3',
    99:'Lucky Magic',100:'HP Recover',101:'TP Recover',
    102:'Rebirth',103:'Rebirth 2',104:'Lucky Soul',105:'Stat Boost',106:'Resurrect',
    107:'Chivalry',108:'Hunter 2',109:'OVL Bonus',110:'OVL Bonus 2',
    111:'Taunt',112:'Taunt 2',113:'OVL Taunt',114:'OVL Taunt 2',115:'Appeal Target',
    116:'Dispersion',117:'Great Deluge',
    118:'Life Healer',119:'Spirit Healer',120:'Life Up',121:'Mental Up',
    122:'Happiness',123:'Happiness 2',124:'Happiness 3',125:'Technical Half',
    126:'Vacance',127:'EXP Share',128:'Cooking Plus',
    129:'Healing Arrow',130:'Healing Arrow 2',131:'Stand Alone',
  },
  // ── Rita Mordio (member 8) ──
  8: {
    // Attack
    0:'Strength',1:'Strength 2',2:'Strength 3',
    3:'Magic',4:'Magic 2',5:'Magic 3',6:'Magic 4',
    7:'Rise Attack',8:'Elemental',9:'Critical Magic',10:'Stun Magic',
    11:'Heavy Magic',12:'Light Magic',13:'Over Cast',14:'Over Cast 2',15:'Over Cast 3',
    16:'Combo Plus',17:'Cross Counter',18:'Reflect',19:'FS Bonus',20:'FS Bonus 2',
    21:'BA Force',22:'Special',
    23:'HP Condition 3',24:'HP Condition 4',25:'Chain',26:'Hell Fire',
    27:'Half Damage',28:'Quarter Damage',29:'Minimum Damage',
    30:'High Magic Tension',31:'Hyper Magic Tension',32:'Fatal Exceed',33:'Burst Hold',
    // Guard
    34:'Defend',35:'Defend 2',36:'Defend 3',37:'Resist',38:'Resist 2',39:'Resist 3',
    40:'Critical Guard',41:'Magic Guard',42:'Guard Plus',43:'Magic Guard Plus',
    44:'Guard Reflect',45:'Guard Artes',46:'Roll',47:'Anti Element',
    48:'Status Guard',49:'Condition Guard',50:'Immunity',
    51:'Endure',52:'Void Attack',53:'Void Magic',54:'Step Away',
    55:'Absorption',56:'Resilience',57:'Perfect Magic',
    58:'TP Condition',59:'TP Condition 2',60:'TP Condition 3',61:'TP Condition 4',
    62:'Crucible',63:'Athenor',64:'Elemental Effect',
    65:'Burst Guard',66:'Recovering Guard',67:'OVL Concentrate',
    // Move
    68:'Evade',69:'Evade 2',70:'Evade 3',71:'Item Thrower',72:'Item Pro',
    73:'Backstep',74:'Recover',75:'Levitation',
    76:'Combo Force',77:'Magic Combo',78:'Liner Shot',
    79:'Spell Charge',80:'Spell Charge 2',81:'Spell Charge 3',
    82:'Rhythm',83:'Randomize',84:'Recast',85:'Overheat',
    86:'Speed Cast',87:'Lucky End',88:'Spell End',89:'Revenge Spell',
    90:'Super Chain 4',91:'O.L. Boost',92:'Alembic',93:'Gale',
    94:'Super Chain 5',95:'Combo Magic',96:'Combo Magic 2',
    // Support
    97:'Vitality',98:'Vitality 2',99:'Vitality 3',
    100:'Spirits',101:'Spirits 2',102:'Spirits 3',103:'Spirits 4',
    104:'Combat Force',105:'Convert Absorption',106:'Reducer',
    107:'HP Recover',108:'TP Recover',
    109:'Rebirth',110:'Rebirth 2',111:'Lucky Soul',112:'Stat Boost',
    113:'Spirit Absorb',114:'Resurrect',115:'OVL Bonus',116:'OVL Bonus 2',
    117:'Taunt',118:'Taunt 2',119:'OVL Taunt',120:'OVL Taunt 2',
    121:'Dispersion',122:'Great Deluge',
    123:'Life Healer',124:'Spirit Healer',125:'Life Up',126:'Mental Up',
    127:'Happiness',128:'Happiness 2',129:'Happiness 3',130:'EXP Share',131:'Stand Alone',
  },
  // ── Estellise (member 9) ──
  9: {
    // Attack
    0:'Strength',1:'Strength 2',2:'Strength 3',3:'Magic',4:'Magic 2',5:'Magic 3',
    6:'Rise Attack',7:'Charming Thrust',8:'Sleepy Thrust',9:'Elemental',10:'Stun Magic',
    11:'Combo Plus',12:'Cross Counter',13:'Reflect',14:'FS Bonus',15:'FS Bonus 2',
    16:'BA Force',17:'Special',
    18:'HP Condition 3',19:'HP Condition 4',20:'Chain',21:'Hell Fire',
    22:'Half Damage',23:'Quarter Damage',24:'Minimum Damage',25:'Fatal Exceed',26:'Burst Hold',
    // Guard
    27:'Defend',28:'Defend 2',29:'Defend 3',30:'Defend 4',
    31:'Resist',32:'Resist 2',33:'Resist 3',34:'Resist 4',
    35:'Critical Guard',36:'Guard Impact',37:'Magic Guard',
    38:'Guard Plus',39:'Guard Plus 2',40:'Magic Guard Plus',41:'Guard Artes',
    42:'Guard Reflect',43:'Extend Guard',44:'Guard Supply',45:'Roll',46:'Anti Element',
    47:'Anti Break',48:'Super Guard',49:'Super Resist',
    50:'Status Guard',51:'Condition Guard',52:'Immunity',53:'Cure Guard',
    54:'Endure',55:'Void Attack',56:'Void Magic',57:'Step Away',
    58:'Guard All',59:'Anti Magic',
    60:'TP Condition',61:'TP Condition 2',62:'TP Condition 3',63:'TP Condition 4',
    64:'Crucible',65:'Athenor',66:'Guardian',67:'Survive',68:'Guard All 2',
    69:'Burst Guard',70:'Recovering Guard',71:'OVL Concentrate',
    // Move
    72:'Evade',73:'Evade 2',74:'Evade 3',75:'Item Thrower',76:'Backstep',77:'Recover',
    78:'Combo Force',
    79:'Extra Combo 1',80:'Extra Combo 2',81:'Extra Combo 3',
    82:'Lucky End',83:'Pow Hammer Revenge',
    84:'Super Chain 4',85:'Super Chain 5',86:'O.L. Boost',
    87:'Alembic',88:'Gale',89:'Item Pro',90:'Rallying Cast',
    // Support
    91:'Vitality',92:'Vitality 2',93:'Vitality 3',94:'Spirits',95:'Spirits 2',96:'Spirits 3',
    97:'Defend Conversion',98:'Resist Conversion',
    99:'Medical Boost',100:'Heal Supply',101:'Eternal Support',102:'Healing Artes',
    103:'HP Recover',104:'TP Recover',105:'Rebirth',106:'Rebirth 2',107:'Lucky Soul',
    108:'Stat Boost',109:'Sleep \'n Heal',110:'Auto Medicine',111:'Resurrect',112:'Angel\'s Tear',
    113:'Lovely Dog',114:'OVL Bonus',115:'OVL Bonus 2',
    116:'Taunt',117:'Taunt 2',118:'OVL Taunt',119:'OVL Taunt 2',
    120:'Dispersion',121:'Great Deluge',
    122:'Life Healer',123:'Spirit Healer',124:'Life Up',125:'Mental Up',
    126:'Happiness',127:'Happiness 2',128:'Happiness 3',129:'EXP Share',
    130:'Auto Medicine 2',131:'High Heal',132:'Hyper Heal',133:'Stand Alone',
  },
};

function itemName(id) {
  return ITEM_NAMES[id] || null;
}

function skillName(charId, skillId) {
  return (SKILL_NAMES[charId] && SKILL_NAMES[charId][skillId]) || null;
}

// ─── Item categories ────────────────────────────────────────────

const ITEM_RANGES = {
  tools:    { start: 0, end: 49, name: 'Tools', icon: '🧪' },
  mains:    { start: 50, end: 399, name: 'Main Weapons', icon: '⚔️' },
  subs:     { start: 400, end: 549, name: 'Sub Weapons', icon: '🗡️' },
  heads:    { start: 550, end: 799, name: 'Head Armor', icon: '⛑️' },
  bodys:    { start: 800, end: 1049, name: 'Body Armor', icon: '🛡️' },
  accessory:{ start: 1050, end: 1374, name: 'Accessories', icon: '💍' },
  material: { start: 1375, end: 1724, name: 'Materials', icon: '🔮' },
  synthesis:{ start: 1725, end: 1799, name: 'Synthesis', icon: '⚗️' },
};

const CHAR_OFFSETS = {
  lv: 8, hp: 12, tp: 16, maxHp: 20, maxTp: 24, exp: 32,
  physAtk: 248, magAtk: 252, physDef: 256, magDef: 260,
  speed: 268, lucky: 272,
  equipMain: 9368, equipSub: 9372, equipBody: 9376, equipHead: 9380,
  sp: 9400, maxSp: 9404,
  skills: 9672,
};

// ─── Helpers ────────────────────────────────────────────────────

function readU32(buf, off) { return buf.readUInt32LE(off); }
function writeU32(buf, off, val) { buf.writeUInt32LE(val, off); return buf; }
function readFloat(buf, off) { return buf.readFloatLE(off); }
function writeFloat(buf, off, val) { buf.writeFloatLE(val, off); }
function readCString(buf, off, maxLen = 64) {
  let end = off;
  while (end < off + maxLen && end < buf.length && buf[end] !== 0) end++;
  return buf.slice(off, end).toString('ascii');
}
function tovr(addr) { return addr + TOVR; }

// ─── Parsing ────────────────────────────────────────────────────

function parseHeader(buf) {
  if (buf.length !== FILE_SIZE) throw new Error(`Expected ${FILE_SIZE} bytes, got ${buf.length}`);
  const magic = readCString(buf, MAGIC_OFFSET, 8);
  if (magic !== MAGIC) throw new Error(`Not a ToV save`);

  let saveId = '';
  for (let i = 0x20; i < 0x35; i++) {
    if (buf[i] === 0x0B || buf[i] === 0x09 || buf[i] === 0x0A) {
      const s = readCString(buf, i + 1, 12);
      if (/^\d{4,8}$/.test(s)) { saveId = s; break; }
    }
  }
  return { version: readU32(buf, 0x00), saveId, timestamp: String(buf.readBigUInt64LE(0x14)) };
}

function parseGald(buf) {
  return {
    gald: readU32(buf, tovr(0xA3D60)),
    maxGald: readU32(buf, tovr(0xA7784)),
    grade: Math.round(readFloat(buf, tovr(0xA7708)) * 100) / 100,
    saveCount: readU32(buf, tovr(0xA778C)),
    encountCount: readU32(buf, tovr(0xA7780)),
    killCount: readU32(buf, tovr(0xA779C)),
    maxHitCount: readU32(buf, tovr(0xA77B0)),
    maxDamage: readU32(buf, tovr(0xA77A8)),
  };
}

function parseItems(buf) {
  const items = {};
  const base = tovr(0xA3D68);
  for (const [key, range] of Object.entries(ITEM_RANGES)) {
    const list = [];
    for (let id = range.start; id <= range.end; id++) {
      const count = readU32(buf, base + id * 4);
      if (count > 0) {
        const name = itemName(id);
        list.push({ id, count, name, offset: base + id * 4 });
      }
    }
    if (list.length > 0) items[key] = { ...range, items: list };
  }
  return items;
}

function parseParty(buf) {
  const party = [];
  const base = tovr(0xA3D38);
  for (let i = 0; i < 9; i++) {
    const memberId = readU32(buf, base + i * 4);
    party.push({ slot: i, memberId, name: MEMBERS[memberId] || `#${memberId}` });
  }
  return party;
}

function parseCharacters(buf) {
  const chars = [];
  for (let value = 1; value <= 9; value++) {
    const charTovrBase = (value - 1) * 0x4010 + 0xA8750;
    const base = tovr(charTovrBase);
    if (base + 16400 > buf.length) break;

    const raw = {};
    for (const [key, off] of Object.entries(CHAR_OFFSETS)) {
      if (key === 'skills') continue;
      raw[key] = readU32(buf, base + off);
    }
    if (raw.hp === 0 && raw.maxHp === 0) continue;

    const skills = [];
    const skillBase = base + CHAR_OFFSETS.skills;
    for (let bit = 0; bit < 160; bit++) {
      if (buf[skillBase + Math.floor(bit / 8)] & (1 << (bit % 8))) {
        const name = skillName(value, bit);
        skills.push({ id: bit, name });
      }
    }

    chars.push({
      id: value, name: MEMBERS[value] || `Member #${value}`,
      stats: raw, skills, skillCount: skills.length,
    });
  }
  return chars;
}

function parseZoneInfo(buf) {
  return {
    zone: readCString(buf, 0x668, 32) || readCString(buf, 0x660, 32),
    weather: readCString(buf, 0x688, 32) || readCString(buf, 0x680, 32),
  };
}

function parse(buf) {
  return {
    header: parseHeader(buf),
    gald: parseGald(buf),
    items: parseItems(buf),
    party: parseParty(buf),
    characters: parseCharacters(buf),
    zoneInfo: parseZoneInfo(buf),
    fileSize: buf.length,
  };
}  // ─── Modify ─────────────────────────────────────────────────────

function modifyGald(buf, gald, maxGald, grade) {
  if (gald !== undefined) writeU32(buf, tovr(0xA3D60), gald);
  if (maxGald !== undefined) writeU32(buf, tovr(0xA7784), maxGald);
  if (grade !== undefined) writeFloat(buf, tovr(0xA7708), grade);
}

function modifyItem(buf, itemId, count) {
  const off = tovr(0xA3D68) + itemId * 4;
  if (off + 4 <= buf.length) writeU32(buf, off, Math.max(0, Math.min(99, count)));
}

function modifyCharStat(buf, memberId, changes) {
  const base = tovr((memberId - 1) * 0x4010 + 0xA8750);
  if (base < 0 || base + 16400 > buf.length) return;
  for (const [key, val] of Object.entries(changes)) {
    const off = CHAR_OFFSETS[key];
    if (off !== undefined && base + off + 4 <= buf.length) writeU32(buf, base + off, val);
  }
}

function modifySkill(buf, memberId, skillId, enabled) {
  const base = tovr((memberId - 1) * 0x4010 + 0xA8750);
  if (base < 0 || base + 16400 > buf.length) return;
  const byteOff = base + CHAR_OFFSETS.skills + Math.floor(skillId / 8);
  if (byteOff < 0 || byteOff >= buf.length) return;
  if (enabled) buf[byteOff] |= (1 << (skillId % 8));
  else buf[byteOff] &= ~(1 << (skillId % 8));
}

function modifyParty(buf, slot, memberId) {
  writeU32(buf, tovr(0xA3D38) + slot * 4, memberId);
}

function modifyCharEquip(buf, memberId, changes) {
  const base = tovr((memberId - 1) * 0x4010 + 0xA8750);
  if (base < 0 || base + 16400 > buf.length) return;
  for (const [key, val] of Object.entries(changes)) {
    const off = CHAR_OFFSETS[key];
    if (off !== undefined && base + off + 4 <= buf.length) writeU32(buf, base + off, val);
  }
}

module.exports = {
  TOVR, FILE_SIZE, MAGIC, MAGIC_OFFSET,
  MEMBERS, ITEM_RANGES, CHAR_OFFSETS, ITEM_NAMES, SKILL_NAMES,
  parse, parseHeader, parseGald, parseItems, parseParty,
  parseCharacters, parseZoneInfo,
  modifyGald, modifyItem, modifyCharStat, modifySkill, modifyParty, modifyCharEquip,
  readU32, writeU32, readFloat, writeFloat, readCString, tovr,
  itemName, skillName,
};
