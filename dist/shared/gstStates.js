import { normaliseKey } from './validators.js';
/**
 * GST state codes (the first two digits of a GSTIN) by state name, for buyers who have no GSTIN: their state is
 * taken from their tehsil. Matching ignores capitals and extra spaces; "&" counts as "and".
 * Only Madhya Pradesh (23) matters for the CGST+SGST / IGST decision, but all of them are listed.
 */
const STATE_CODES = {
    'jammu and kashmir': '01',
    'himachal pradesh': '02',
    punjab: '03',
    chandigarh: '04',
    uttarakhand: '05',
    uttaranchal: '05',
    haryana: '06',
    delhi: '07',
    'nct of delhi': '07',
    rajasthan: '08',
    'uttar pradesh': '09',
    bihar: '10',
    sikkim: '11',
    'arunachal pradesh': '12',
    nagaland: '13',
    manipur: '14',
    mizoram: '15',
    tripura: '16',
    meghalaya: '17',
    assam: '18',
    'west bengal': '19',
    jharkhand: '20',
    odisha: '21',
    orissa: '21',
    chhattisgarh: '22',
    'madhya pradesh': '23',
    gujarat: '24',
    'dadra and nagar haveli and daman and diu': '26',
    'dadra and nagar haveli': '26',
    'daman and diu': '26',
    maharashtra: '27',
    karnataka: '29',
    goa: '30',
    lakshadweep: '31',
    kerala: '32',
    'tamil nadu': '33',
    puducherry: '34',
    pondicherry: '34',
    'andaman and nicobar islands': '35',
    telangana: '36',
    'andhra pradesh': '37',
    ladakh: '38',
};
/** The 2-digit GST state code for a state name, or undefined if the name is not recognised. */
export function gstStateCode(stateName) {
    return STATE_CODES[normaliseKey(stateName.replace(/&/g, ' and '))];
}
//# sourceMappingURL=gstStates.js.map