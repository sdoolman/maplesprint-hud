// @ts-check
"use strict";

/**
 * Shared JSDoc TypeScript domain definitions for MapleSprint HUD.
 * Pure type declarations (zero runtime overhead).
 */

/**
 * Minimal storage interface (compatible with `localStorage` and in-memory test doubles).
 * @typedef {object} StorageLike
 * @property {(key: string) => string | null} getItem
 * @property {(key: string, value: string) => void} setItem
 * @property {(key: string) => void} removeItem
 */

/**
 * @typedef {object} MapRecord
 * @property {string} name
 * @property {string} street
 * @property {string} [region]
 * @property {boolean} [isTown]
 * @property {number | null} [mobCapacity]
 * @property {Array<{ id: number, x: number, y: number }>} [mobPositions]
 * @property {Array<{ id: number, count: number }>} [spawns]
 */

/**
 * @typedef {object} MobRecord
 * @property {string} name
 * @property {number} [level]
 * @property {number} [exp]
 * @property {number} [hp]
 * @property {boolean} undead
 * @property {Record<string, string>} [elements]
 * @property {boolean} [boss]
 */

/**
 * @typedef {object} ItemRecord
 * @property {string} name
 * @property {string} [cat]
 * @property {number | null} price
 */

/**
 * @typedef {object} GuideMapMob
 * @property {number} id
 * @property {string} name
 * @property {number} level
 * @property {number} exp
 * @property {number} hp
 * @property {number} [hpPerExp]
 * @property {number} count
 * @property {boolean} [undead]
 * @property {Record<string, string>} [elements]
 */

/**
 * @typedef {object} GuideMapEntry
 * @property {number} [mapId]
 * @property {number} [id]
 * @property {string} name
 * @property {string} street
 * @property {string} [region]
 * @property {number} avgLevel
 * @property {number} avgExp
 * @property {number} [avgHpPerExp]
 * @property {number} [avgRatio]
 * @property {number} totalSpawns
 * @property {number | null} [spatialDensity]
 * @property {boolean} [hasUndead]
 * @property {boolean} [hasFireWeak]
 * @property {boolean} [hasIceWeak]
 * @property {boolean} [hasLightningWeak]
 * @property {boolean} [hasHolyWeak]
 * @property {boolean} [hasPoisonWeak]
 * @property {boolean} [hasFireResist]
 * @property {boolean} [hasIceResist]
 * @property {boolean} [hasLightningResist]
 * @property {boolean} [hasHolyResist]
 * @property {boolean} [hasPoisonResist]
 * @property {GuideMapMob[]} mobs
 */

/**
 * @typedef {object} CatalogData
 * @property {Record<number, MapRecord>} maps
 * @property {Record<number, MobRecord>} mobs
 * @property {Record<number, ItemRecord>} items
 * @property {GuideMapEntry[]} guideMaps
 * @property {boolean} loaded
 */

/**
 * @typedef {object} MobKillTally
 * @property {number} count
 * @property {number} exp
 */

/**
 * @typedef {object} MapSplit
 * @property {number} map_id
 * @property {number | null} channel
 * @property {number} started_ts
 * @property {number} active_ms
 * @property {number} exp_gained
 * @property {number} kills
 * @property {Record<number, MobKillTally>} [killsByMob]
 * @property {number} mesos_gained
 * @property {number} drops
 */

/**
 * @typedef {object} SessionState
 * @property {number | null} startTs
 * @property {number} activeMs
 * @property {number | null} lastActiveTs
 * @property {number} sessionExp
 * @property {number} lastExp
 * @property {number} totalExp
 * @property {number} level
 * @property {number} job
 * @property {number} kills
 * @property {Record<number, MobKillTally>} killsByMob
 * @property {number | null} lastMobId
 * @property {number} mesos
 * @property {number} npcLootValue
 * @property {number} drops
 * @property {Record<number, number>} dropsByItem
 * @property {number | null} lastItemId
 * @property {number | null} hp
 * @property {number | null} mp
 * @property {number | null} maxHp
 * @property {number | null} maxMp
 * @property {number} damageTaken
 * @property {number} damageDealt
 * @property {number | null} mapId
 * @property {number | null} ch
 * @property {number} events
 * @property {number} rawChunksReceived
 * @property {number} observedWgPort
 * @property {Array<{ ts: number, gain: number }>} expWindow
 * @property {MapSplit[]} mapSplits
 * @property {MapSplit | null} currentSplit
 */

/**
 * @typedef {object} MeasuredRates
 * @property {number} [xph]
 * @property {number} [kpm]
 * @property {number} [mph]
 * @property {number} [dpm]
 */

/**
 * @typedef {object} LevelProgress
 * @property {number} pct
 * @property {string} pctLabel
 * @property {string} etaLabel
 * @property {string} expDetail
 */

/**
 * @typedef {"all" | "general" | "exp" | "kills" | "drops" | "mesos" | "challenges"} FeedCategory
 */

/**
 * @typedef {object} FeedItemDescriptor
 * @property {string} text
 * @property {FeedCategory} category
 * @property {boolean} [major]
 */

/**
 * @typedef {object} TelemetryEvent
 * @property {string} type
 * @property {number} [ts]
 * @property {number} [gain]
 * @property {boolean} [loss]
 * @property {number} [total_exp]
 * @property {number | null} [mob_id]
 * @property {boolean} [self_kill]
 * @property {number | null} [map_id]
 * @property {number | null} [channel]
 * @property {number} [level]
 * @property {number} [job]
 * @property {number | null} [hp]
 * @property {number | null} [mp]
 * @property {number} [max_hp]
 * @property {number} [max_mp]
 * @property {number} [damage_taken]
 * @property {number} [mp_delta]
 * @property {number} [item_id]
 * @property {number} [qty]
 * @property {number} [amount]
 */

/**
 * @typedef {object} InitPayload
 * @property {number | null} [hp]
 * @property {number | null} [mp]
 * @property {number} [max_hp]
 * @property {number} [max_mp]
 * @property {number | null} [map_id]
 * @property {number | null} [channel]
 * @property {number} [total_exp]
 * @property {number} [level]
 * @property {number} [job]
 * @property {number} [session_exp]
 * @property {number} [session_start_ts]
 * @property {number} [active_ms]
 * @property {number} [kills]
 * @property {number} [mesos]
 * @property {number} [drops]
 * @property {MapSplit[]} [map_splits]
 */

/**
 * @typedef {"exp_pct" | "time" | "kills" | "mesos" | "drops" | "mix"} SprintGoalType
 */

/**
 * @typedef {"relaxed" | "balanced" | "ambitious"} SprintPace
 */

/**
 * @typedef {"any" | "all"} SprintCompoundRule
 */

/**
 * @typedef {object} SprintGoal
 * @property {"exp_pct" | "time" | "kills" | "mesos" | "drops"} type
 * @property {string} label
 * @property {number} [targetPct]
 * @property {number} [targetExp]
 * @property {number} [targetMs]
 * @property {number} [targetKills]
 * @property {number | null} [mobId]
 * @property {string | null} [mobName]
 * @property {number} [targetMesos]
 * @property {number} [targetDrops]
 */

/**
 * @typedef {object} TargetSprint
 * @property {string} id
 * @property {string} title
 * @property {SprintGoalType} type
 * @property {SprintPace} pace
 * @property {SprintCompoundRule} compound
 * @property {number | null} mapId
 * @property {string | null} mapName
 * @property {SprintGoal[]} goals
 * @property {number} startedAt
 * @property {boolean} completed
 * @property {number | null} completedAt
 */

/**
 * @typedef {object} SprintEstimate
 * @property {number} estMins
 * @property {"Relaxed" | "Balanced" | "Ambitious"} difficulty
 * @property {boolean} suggestSplit
 * @property {string | null} splitHint
 * @property {string} rateSource
 */

/**
 * @typedef {SprintGoal & {
 *   cur: number,
 *   target: number,
 *   pct: number,
 *   done: boolean,
 *   curLabel: string,
 *   targetLabel: string,
 *   remMins: number | null,
 * }} SubGoalProgress
 */

/**
 * @typedef {object} SprintProgress
 * @property {number} pct
 * @property {boolean} completed
 * @property {string} etaLabel
 * @property {string} summaryLabel
 * @property {SubGoalProgress[]} subGoals
 */

/**
 * @typedef {object} SprintHistoryEntry
 * @property {string} id
 * @property {string} title
 * @property {number} completedAt
 */

/**
 * @typedef {"exp" | "kills" | "mob_kills" | "mesos" | "drops" | "maps" | "active_mins" | "weekly_sprints" | "kills_and_drops"} ChallengeMetric
 */

/**
 * @typedef {object} ChallengeTemplate
 * @property {string} id
 * @property {string} category
 * @property {string} title
 * @property {ChallengeMetric} metric
 * @property {number} target
 * @property {number} [secondaryTarget]
 * @property {number} [mobId]
 * @property {string} unit
 */

/**
 * @typedef {ChallengeTemplate & {
 *   progress: number,
 *   secondaryProgress: number,
 *   completed: boolean,
 *   completedAt: number | null,
 *   visitedMaps: number[],
 * }} ActiveChallenge
 */

/**
 * @typedef {object} ChallengeMobContext
 * @property {number | null} [mobId]
 * @property {string | null} [mobName]
 */

/**
 * @typedef {object} PlannedMapContext
 * @property {number} mapId
 * @property {string} name
 * @property {GuideMapMob[]} mobs
 */

/**
 * @typedef {object} PipSnapshot
 * @property {number} xphVal
 * @property {number} rolling5m
 * @property {number} level
 * @property {number} pct
 * @property {string} etaText
 * @property {boolean} isGrinding
 * @property {string} mapName
 */

export {};
