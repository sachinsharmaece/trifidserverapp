import { ReasonCodeModel } from '../../models/index.js';
import { invalidField } from '../../shared/errors.js';
/**
 * The reason a person picked from a dropdown, checked: it must exist, be turned on and belong to this dropdown's
 * context (SRS-MST-07). A bad pick is a 422 on `reasonCodeId`.
 */
export async function reasonFor(reasonCodeId, context) {
    const reason = await ReasonCodeModel.findById(reasonCodeId);
    if (!reason?.active || reason.context !== context) {
        throw invalidField('reasonCodeId', 'Choose a reason from the list.');
    }
    return reason;
}
//# sourceMappingURL=reasons.js.map