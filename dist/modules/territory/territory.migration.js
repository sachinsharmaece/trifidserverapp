import mongoose from 'mongoose';
import { State } from '../../models/State.js';
import { District } from '../../models/District.js';
import { Tehsil } from '../../models/Tehsil.js';
import { STATE_ALIASES, STATE_SEED } from '../../config/states.js';
import { seedStates } from '../../db/seedStates.js';
import { toTitleCase } from './territory.masters.js';
/**
 * Phase 1 — links every tehsil's free-text district/state to the masters.
 *
 * - State text is matched to the State master ("MP", "mp", "M.P.",
 *   "Madhya Pradesh" → Madhya Pradesh) by its letters only, or an alias.
 * - District text is trimmed and title-cased ("ujjain" → Ujjain) and matched
 *   case-insensitively within that state; a district not in the master yet
 *   is created.
 * - The tehsil gets `districtId`, and its `district`/`state` text becomes the
 *   master's names. An all-lowercase tehsil name is capitalised.
 * - **Nothing is deleted or merged.** Two tehsils that would land on the
 *   same name in the same district are a *conflict*: one is linked, the
 *   other is left as it was and reported. Look-alike names (Mahidpur /
 *   Mehidpur, a comma in "Patera,damoh") are reported as suspected
 *   duplicates for a person to decide.
 *
 * A dry run (the default) writes nothing. `apply` first copies each changed
 * tehsil's original text into `tehsil_location_migration_backup` (once per
 * tehsil), which is what `rollbackLocationMigration` restores. Running it
 * again changes nothing.
 */
export const BACKUP_COLLECTION = 'tehsil_location_migration_backup';
const lettersOnly = (value) => value.toLowerCase().replace(/[^a-z]/g, '');
function levenshtein(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i += 1) {
        let previous = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const current = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
            previous = current;
        }
    }
    return row[b.length];
}
// Names a person should look at side by side: the same letters once
// punctuation and spaces are ignored, or one letter apart. Two letters was
// tried against the real MP master and flagged distinct places (Harda /
// Handia, Katni / Satna); one letter keeps the real suspects (Mahidpur /
// Mehidpur, barnagar / Badnagar).
function looksAlike(a, b) {
    const la = lettersOnly(a);
    const lb = lettersOnly(b);
    if (la === lb)
        return 'the same letters, written differently';
    if (Math.min(la.length, lb.length) >= 5 && levenshtein(la, lb) <= 1) {
        return 'spelled one letter apart';
    }
    return null;
}
function suspectedDuplicatesIn(place, names) {
    const found = [];
    const unique = [...new Set(names)];
    for (let i = 0; i < unique.length; i += 1) {
        for (let j = i + 1; j < unique.length; j += 1) {
            const reason = looksAlike(unique[i], unique[j]);
            if (reason)
                found.push({ place, names: [unique[i], unique[j]], reason });
        }
    }
    for (const name of unique) {
        if (/[,;/]/.test(name)) {
            found.push({
                place,
                names: [name],
                reason: 'the name has a comma or slash in it — it may be two places typed into one field',
            });
        }
    }
    return found;
}
export async function migrateLocationMasters(options) {
    // A dry run writes nothing — not even the state seed. States the server
    // has not seeded yet are taken from the seed list in memory instead.
    if (options.apply)
        await seedStates();
    const report = {
        mode: options.apply ? 'apply' : 'dry-run',
        tehsilsScanned: 0,
        alreadyLinked: 0,
        linked: [],
        districtsCreated: [],
        unknownState: [],
        conflicts: [],
        suspectedDuplicates: [],
    };
    const states = (await State.find()).map((s) => ({
        id: String(s._id),
        name: s.name,
    }));
    for (const seed of STATE_SEED) {
        if (!states.some((s) => lettersOnly(s.name) === lettersOnly(seed.name))) {
            states.push({ id: `not-yet-seeded-${seed.gstStateCode}`, name: seed.name });
        }
    }
    const stateByKey = new Map();
    for (const state of states)
        stateByKey.set(lettersOnly(state.name), state);
    for (const [alias, name] of Object.entries(STATE_ALIASES)) {
        const state = stateByKey.get(lettersOnly(name));
        if (state && !stateByKey.has(alias))
            stateByKey.set(alias, state);
    }
    // District master as it stands, plus the ones this run would create.
    const districts = await District.find();
    const districtByKey = new Map();
    for (const d of districts) {
        districtByKey.set(`${String(d.stateId)}|${d.name.toLowerCase()}`, {
            id: d._id,
            name: d.name,
        });
    }
    const tehsils = await Tehsil.find().sort({ createdAt: 1, _id: 1 });
    report.tehsilsScanned = tehsils.length;
    const plans = [];
    for (const tehsil of tehsils) {
        const state = stateByKey.get(lettersOnly(tehsil.state));
        if (!state) {
            report.unknownState.push({
                tehsil: tehsil.name,
                district: tehsil.district,
                state: tehsil.state,
            });
            continue;
        }
        const districtName = toTitleCase(tehsil.district);
        const districtKey = `${state.id}|${districtName.toLowerCase()}`;
        plans.push({
            tehsil,
            stateId: state.id,
            stateName: state.name,
            districtKey,
            districtName: districtByKey.get(districtKey)?.name ?? districtName,
            tehsilName: tehsil.name === tehsil.name.toLowerCase() ? toTitleCase(tehsil.name) : tehsil.name,
        });
    }
    // Pass 2 — one tehsil per (district, name). Prefer the one already linked,
    // then the one whose text already matches, then the oldest.
    const groups = new Map();
    for (const plan of plans) {
        const key = `${plan.districtKey}|${plan.tehsil.name.toLowerCase()}`;
        groups.set(key, [...(groups.get(key) ?? []), plan]);
    }
    const winners = [];
    for (const group of groups.values()) {
        const score = (p) => (p.tehsil.districtId ? 2 : 0) +
            (p.tehsil.district === p.districtName &&
                p.tehsil.state === p.stateName &&
                p.tehsil.name === p.tehsilName
                ? 1
                : 0);
        const ordered = [...group].sort((a, b) => score(b) - score(a));
        const [keep, ...rest] = ordered;
        winners.push(keep);
        for (const other of rest) {
            report.conflicts.push({
                tehsil: `${other.tehsil.name} (${other.tehsil.district}, ${other.tehsil.state})`,
                district: `${other.districtName}, ${other.stateName}`,
                keptTehsil: `${keep.tehsil.name} (${keep.tehsil.district}, ${keep.tehsil.state})`,
                reason: 'the same tehsil name already exists in this district — left unlinked, not merged',
            });
        }
    }
    // Suspected duplicates — tehsils within a district, districts within a state.
    const namesByDistrict = new Map();
    for (const plan of plans) {
        const entry = namesByDistrict.get(plan.districtKey) ?? {
            place: `${plan.districtName}, ${plan.stateName}`,
            names: [],
        };
        entry.names.push(plan.tehsil.name);
        namesByDistrict.set(plan.districtKey, entry);
    }
    for (const { place, names } of namesByDistrict.values()) {
        report.suspectedDuplicates.push(...suspectedDuplicatesIn(place, names));
    }
    const districtNamesByState = new Map();
    for (const plan of plans) {
        const entry = districtNamesByState.get(plan.stateId) ?? {
            place: plan.stateName,
            names: new Set(),
        };
        entry.names.add(plan.districtName);
        districtNamesByState.set(plan.stateId, entry);
    }
    for (const { place, names } of districtNamesByState.values()) {
        for (const hit of suspectedDuplicatesIn(place, [...names])) {
            report.suspectedDuplicates.push({ ...hit, reason: `districts: ${hit.reason}` });
        }
    }
    // Pass 3 — link the winners.
    const backup = mongoose.connection.collection(BACKUP_COLLECTION);
    for (const plan of winners) {
        let district = districtByKey.get(plan.districtKey);
        if (!district) {
            report.districtsCreated.push(`${plan.districtName}, ${plan.stateName}`);
            district = { id: null, name: plan.districtName };
            if (options.apply) {
                const created = await District.create({ name: plan.districtName, stateId: plan.stateId });
                district.id = created._id;
            }
            districtByKey.set(plan.districtKey, district);
        }
        const { tehsil } = plan;
        const unchanged = tehsil.districtId !== null &&
            district.id !== null &&
            String(tehsil.districtId) === String(district.id) &&
            tehsil.district === district.name &&
            tehsil.state === plan.stateName &&
            tehsil.name === plan.tehsilName;
        if (unchanged) {
            report.alreadyLinked += 1;
            continue;
        }
        report.linked.push({
            tehsil: tehsil.name === plan.tehsilName ? tehsil.name : `${tehsil.name} → ${plan.tehsilName}`,
            from: `${tehsil.district}, ${tehsil.state}`,
            to: `${district.name}, ${plan.stateName}`,
        });
        if (!options.apply)
            continue;
        await backup.updateOne({ tehsilId: tehsil._id }, {
            $setOnInsert: {
                tehsilId: tehsil._id,
                name: tehsil.name,
                district: tehsil.district,
                state: tehsil.state,
                districtId: tehsil.districtId ?? null,
                savedAt: new Date(),
            },
        }, { upsert: true });
        await Tehsil.updateOne({ _id: tehsil._id }, {
            $set: {
                name: plan.tehsilName,
                districtId: district.id,
                district: district.name,
                state: plan.stateName,
            },
        });
    }
    return report;
}
/**
 * Puts every tehsil the migration changed back to its original text and
 * link. The State and District masters are left in place: nothing points at
 * them once the tehsils are restored, and deleting masters is not this
 * script's call.
 */
export async function rollbackLocationMigration() {
    const backup = mongoose.connection.collection(BACKUP_COLLECTION);
    const rows = await backup.find().toArray();
    for (const row of rows) {
        await Tehsil.updateOne({ _id: row.tehsilId }, {
            $set: {
                ...(row.name ? { name: row.name } : {}),
                district: row.district,
                state: row.state,
                districtId: row.districtId ?? null,
            },
        });
    }
    await backup.deleteMany({});
    return { restored: rows.length };
}
