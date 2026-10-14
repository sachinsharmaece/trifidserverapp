import { getExceptionView } from '../controller/controller.service.js';
import { getBuyerMoneyHeld } from '../payment/payment.service.js';
import { getFunnelReport } from '../desk/purchase/purchase.funnel.js';
export async function getFounderOverview() {
    const [buyerMoneyHeld, exceptions, funnel] = await Promise.all([
        getBuyerMoneyHeld(),
        getExceptionView(),
        getFunnelReport(),
    ]);
    return { asOf: new Date().toISOString(), buyerMoneyHeld, exceptions, funnel };
}
