import { Schema, model } from 'mongoose';
import { INTEGRITY_CHECKS, JOB_NAMES, JOB_RUN_STATUSES, JOB_TRIGGERS } from '../shared/enums.js';
import { intField, refField, textField } from './_fields.js';
/** The most findings one run keeps. `findingCount` is always the true number. */
export const MAX_STORED_FINDINGS = 200;
/**
 * One run of a system job (ARCH §3.8 and §4.6), kept as a log: when it ran, who started it, and what it found.
 * Today only the integrity check writes here. A run is written once when it finishes and never changed.
 */
const jobRunSchema = new Schema({
    job: { type: String, enum: JOB_NAMES, required: true },
    trigger: { type: String, enum: JOB_TRIGGERS, required: true },
    /** The person who pressed "Run now". Empty for the nightly run. */
    startedBy: refField('User'),
    startedAt: { type: Date, required: true },
    finishedAt: { type: Date, required: true },
    status: { type: String, enum: JOB_RUN_STATUSES, required: true },
    /** How many records the check looked at, so "0 findings" is known to mean something. */
    checked: {
        type: new Schema({
            salesOrders: { ...intField(0), required: true },
            purchaseOrders: { ...intField(0), required: true },
            receipts: { ...intField(0), required: true },
            vouchers: { ...intField(0), required: true },
        }, { _id: false }),
        required: true,
    },
    findingCount: { ...intField(0), required: true },
    findings: [
        new Schema({
            check: { type: String, enum: INTEGRITY_CHECKS, required: true },
            /** The record the finding is about, like "SO-26-0004" or "SV-26-0002". */
            ref: { ...textField(60), required: true },
            message: { ...textField(300), required: true },
        }, { _id: false }),
    ],
    /** Only when the check itself crashed. */
    error: textField(300),
}, { collection: 'job_runs', timestamps: true, versionKey: false });
jobRunSchema.index({ job: 1, startedAt: -1 });
export const JobRunModel = model('JobRun', jobRunSchema);
//# sourceMappingURL=jobRun.model.js.map