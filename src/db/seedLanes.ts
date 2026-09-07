import { Lane } from '../models/Lane.js';
import { LANE_SEED } from '../config/permissions.js';

/** BR-262 needs the lane board to exist before any employee can be created. */
export async function seedLanes(): Promise<void> {
  for (const lane of LANE_SEED) {
    await Lane.findOneAndUpdate(
      { key: lane.key },
      { $set: { funnel: lane.funnel, label: lane.label } },
      { upsert: true },
    );
  }
}
