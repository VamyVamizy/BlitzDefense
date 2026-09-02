// Wave Management System
class WaveManager {
   constructor(difficultySettings = {}) {
    this.waves = {};

    this.setDifficultySettings(difficultySettings, false);

    this.rebuildWaves();
}

    normalizeDifficultySettings(difficultySettings = {}) {
        return {
            enemyHealthMultiplier: 1,
            enemySpeedMultiplier: 1,
            rewardMultiplier: 1,
            spawnCountMultiplier: 1,
            maxWaves: 40,
            ...difficultySettings
        };
    }

    setDifficultySettings(difficultySettings = {}, rebuild = true) {
    this.difficultySettings =
        this.normalizeDifficultySettings(difficultySettings);

    this.maxWave = this.difficultySettings.maxWaves;

    if (rebuild) {
        this.rebuildWaves();
    }
}

    rebuildWaves() {
        this.waves = {};
        for (let wave = 1; wave <= this.maxWave; wave++) {
            this.waves[wave] = this.buildWave(wave);
        }
    }

    scaleCounts(counts) {
        const multiplier = this.difficultySettings?.spawnCountMultiplier ?? 1;
        const scaled = {};

        for (const [key, value] of Object.entries(counts)) {
            if (key === 'smith') {
                scaled[key] = value;
                continue;
            }

            scaled[key] = Math.max(0, Math.round(value * multiplier));
        }

        return scaled;
    }

    composeWave(counts) {
        const scaledCounts = this.scaleCounts(counts);
        const roster = [
            [Smith, scaledCounts.smith || 0],
            [Boss3, scaledCounts.boss3 || 0],
            [Boss2, scaledCounts.boss2 || 0],
            [Boss1, scaledCounts.boss1 || 0],
            [Tank3, scaledCounts.tank3 || 0],
            [Tank2, scaledCounts.tank2 || 0],
            [Tank1, scaledCounts.tank1 || 0],
            [Sprinter3, scaledCounts.sprinter3 || 0],
            [Sprinter2, scaledCounts.sprinter2 || 0],
            [Sprinter1, scaledCounts.sprinter1 || 0],
            [Enemy3, scaledCounts.enemy3 || 0],
            [Enemy2, scaledCounts.enemy2 || 0],
            [Enemy1, scaledCounts.enemy1 || 0]
        ];

        const wave = [];
        let hasRemaining = true;

        while (hasRemaining) {
            hasRemaining = false;
            for (let i = 0; i < roster.length; i++) {
                const pair = roster[i];
                if (pair[1] > 0) {
                    wave.push(pair[0]);
                    pair[1]--;
                    hasRemaining = true;
                }
            }
        }

        return wave;
    }

    buildWave(wave) {
        // Phase 1 (1-10): onboarding and early ramp
        if (wave <= 10) {
            const counts = {
                enemy1: 10 + wave,
                enemy2: Math.max(0, wave - 2),
                enemy3: 0,
                tank1: wave >= 6 ? Math.floor((wave - 4) / 3) : 0,
                tank2: 0,
                tank3: 0,
                sprinter1: Math.floor((wave - 1) / 2),
                sprinter2: 0,
                sprinter3: 0,
                boss1: 0,
                boss2: 0,
                boss3: 0,
                smith: 0
            };
            return this.composeWave(counts);
        }

        // Phase 2 (11-19): transition to mixed mid-tier pressure
        if (wave <= 19) {
            const p = wave - 10;
            const counts = {
                enemy1: Math.max(2, 12 - p),
                enemy2: 6 + p,
                enemy3: Math.max(0, p - 3),
                tank1: 1 + Math.floor((p + 1) / 3),
                tank2: Math.max(0, Math.floor((p - 2) / 2)),
                tank3: 0,
                sprinter1: 3 + Math.floor(p / 2),
                sprinter2: Math.max(0, Math.floor((p - 3) / 2)),
                sprinter3: 0,
                boss1: 0,
                boss2: 0,
                boss3: 0,
                smith: 0
            };
            return this.composeWave(counts);
        }

        // Phase 3 (20-29): boss era starts, one boss each wave
        if (wave <= 29) {
            const p = wave - 20;
            const counts = {
                enemy1: 2,
                enemy2: 6,
                enemy3: 6 + p,
                tank1: 2 + Math.floor((p + 1) / 3),
                tank2: 1 + Math.floor((p + 1) / 2),
                tank3: 0,
                sprinter1: 2 + Math.floor(p / 3),
                sprinter2: 2 + Math.floor(p / 2),
                sprinter3: 0,
                boss1: wave >= 25 ? 2 : 1,
                boss2: wave >= 27 ? 1 : 0,
                boss3: 0,
                smith: 0
            };
            return this.composeWave(counts);
        }

        // Phase 4 (30-35): elite-heavy waves, occasional double-boss
        if (wave <= 35) {
            const p = wave - 30;
            const counts = {
                enemy1: 0,
                enemy2: 4,
                enemy3: 10 + p,
                tank1: 2 + Math.floor((p + 1) / 2),
                tank2: 3 + Math.floor(p / 2),
                tank3: Math.max(0, Math.floor((p - 2) / 2)),
                sprinter1: 1,
                sprinter2: 5 + Math.floor(p / 2),
                sprinter3: Math.max(0, Math.floor((p - 3) / 3)),
                boss1: 1,
                boss2: 2 + Math.floor(p / 3),
                boss3: Math.max(0, Math.floor((p - 4) / 3)),
                smith: 0
            };
            return this.composeWave(counts);
        }

        // Phase 5 (36-40): final escalation
        if (wave <= 40) {
            const p = wave - 35;
            const counts = {
                enemy1: 0,
                enemy2: 2,
                enemy3: 12 + p * 2,
                tank1: 1,
                tank2: 4 + p,
                tank3: 3 + p,
                sprinter1: 0,
                sprinter2: 7 + p,
                sprinter3: 3 + Math.floor(p / 2),
                boss1: 1,
                boss2: 2 + p,
                boss3: 1 + Math.floor(p / 2),
                smith: 0
            };
            return this.composeWave(counts);
        }

        // Phase 6 (41+): Endless mode
        if (wave >= 41) {
            return this.buildEndlessWave(wave);
        }
    }

    getWave(waveNumber) {
        if (waveNumber <= 40) {
            return this.waves[waveNumber] || this.waves[1]; // Default to wave 1 if not found\
        }

        // For endless mode (41+), generate on demand
        return this.buildEndlessWave(waveNumber);
    }

    hasWave(waveNumber) {
        return this.waves.hasOwnProperty(waveNumber);
    }

    getTotalWaves() {
        return this.maxWave;
    }

    buildEndlessWave(wave) {
        const endlessWave = wave; // Keep absolute wave numbering for Smith
        const tierIncrease = Math.floor((endlessWave - 40) / 10);

        // 🎯 SMITH SPAWNS ALONE - Check this FIRST
        if (endlessWave % 100 === 0) {
            return this.composeWave({
                enemy1: 0, enemy2: 0, enemy3: 0,
                tank1: 0, tank2: 0, tank3: 0,
                sprinter1: 0, sprinter2: 0, sprinter3: 0,
                boss1: 0, boss2: 0, boss3: 0,
                smith: 1  // Only Smith spawns
            });
        }

        // Normal endless wave scaling (when Smith is NOT spawning)
        const counts = {
            // Phase out basic enemies completely
            enemy1: 0,

            // Enemy2: Start at 6, reduce by 1 every tier, min 0
            enemy2: Math.max(0, 6 - tierIncrease),

            // Enemy3: Start at 8, increase by 1 every tier  
            enemy3: 8 + tierIncrease,

            // Tank1: Start at 3, reduce by 1 every 2 tiers, min 0
            tank1: Math.max(0, 3 - Math.floor(tierIncrease / 2)),

            // Tank2: Start at 4, stay constant for first few tiers, then increase
            tank2: 4 + Math.max(0, tierIncrease - 2),

            // Tank3: Start at 2, increase by 1 every tier
            tank3: 2 + tierIncrease,

            // Sprinter1: Start at 2, reduce by 1 every 2 tiers, min 0  
            sprinter1: Math.max(0, 2 - Math.floor(tierIncrease / 2)),

            // Sprinter2: Start at 5, stay constant for first tier, then increase
            sprinter2: 5 + Math.max(0, tierIncrease - 1),

            // Sprinter3: Start at 3, increase by 1 every tier
            sprinter3: 3 + tierIncrease,

            // Bosses: Start conservative, increase gradually
            boss1: Math.max(1, 2 - Math.floor(tierIncrease / 3)), // Phase out slowly
            boss2: 2 + tierIncrease,                              // Steady increase
            boss3: 1 + Math.floor(tierIncrease / 2),              // Moderate increase

            smith: 0 // No Smith on regular waves
        };

        const totalEnemies = Object.values(counts).reduce((a, b) => a + b, 0);
        console.log(`Endless wave ${endlessWave}: Tier ${tierIncrease}, ${totalEnemies} enemies`);

        return this.composeWave(counts);
    }
}