/**
 * Phase 1 — the State master's seed: every state and union territory with
 * its two-digit GST state code, exactly as listed in the client's prompt
 * (`claude_code_prompt_team_buyer_seller.md`, Phase 1). Code 25 (the old
 * Daman and Diu) and 28 (old Andhra Pradesh) are retired and not seeded.
 * `97 Other Territory` has no GSTIN prefix check (shared/validators.ts).
 */
export const STATE_SEED = [
    { gstStateCode: '01', name: 'Jammu and Kashmir' },
    { gstStateCode: '02', name: 'Himachal Pradesh' },
    { gstStateCode: '03', name: 'Punjab' },
    { gstStateCode: '04', name: 'Chandigarh' },
    { gstStateCode: '05', name: 'Uttarakhand' },
    { gstStateCode: '06', name: 'Haryana' },
    { gstStateCode: '07', name: 'Delhi' },
    { gstStateCode: '08', name: 'Rajasthan' },
    { gstStateCode: '09', name: 'Uttar Pradesh' },
    { gstStateCode: '10', name: 'Bihar' },
    { gstStateCode: '11', name: 'Sikkim' },
    { gstStateCode: '12', name: 'Arunachal Pradesh' },
    { gstStateCode: '13', name: 'Nagaland' },
    { gstStateCode: '14', name: 'Manipur' },
    { gstStateCode: '15', name: 'Mizoram' },
    { gstStateCode: '16', name: 'Tripura' },
    { gstStateCode: '17', name: 'Meghalaya' },
    { gstStateCode: '18', name: 'Assam' },
    { gstStateCode: '19', name: 'West Bengal' },
    { gstStateCode: '20', name: 'Jharkhand' },
    { gstStateCode: '21', name: 'Odisha' },
    { gstStateCode: '22', name: 'Chhattisgarh' },
    { gstStateCode: '23', name: 'Madhya Pradesh' },
    { gstStateCode: '24', name: 'Gujarat' },
    { gstStateCode: '26', name: 'Dadra and Nagar Haveli and Daman and Diu' },
    { gstStateCode: '27', name: 'Maharashtra' },
    { gstStateCode: '29', name: 'Karnataka' },
    { gstStateCode: '30', name: 'Goa' },
    { gstStateCode: '31', name: 'Lakshadweep' },
    { gstStateCode: '32', name: 'Kerala' },
    { gstStateCode: '33', name: 'Tamil Nadu' },
    { gstStateCode: '34', name: 'Puducherry' },
    { gstStateCode: '35', name: 'Andaman and Nicobar Islands' },
    { gstStateCode: '36', name: 'Telangana' },
    { gstStateCode: '37', name: 'Andhra Pradesh' },
    { gstStateCode: '38', name: 'Ladakh' },
    { gstStateCode: '97', name: 'Other Territory' },
];
/**
 * Free-text spellings the old tehsil records use for a state, mapped to the
 * master's name. Keys are lowercase with everything but letters removed, so
 * "MP", "mp", "M.P." and "Madhya  Pradesh" all land on one key. Used only by
 * the location-master migration; a master name itself always matches too.
 */
export const STATE_ALIASES = {
    mp: 'Madhya Pradesh',
    madhyapradesh: 'Madhya Pradesh',
    mh: 'Maharashtra',
    gj: 'Gujarat',
    rj: 'Rajasthan',
    up: 'Uttar Pradesh',
    cg: 'Chhattisgarh',
    ct: 'Chhattisgarh',
    chattisgarh: 'Chhattisgarh',
    dl: 'Delhi',
    newdelhi: 'Delhi',
    hr: 'Haryana',
    pb: 'Punjab',
    br: 'Bihar',
    jh: 'Jharkhand',
    od: 'Odisha',
    or: 'Odisha',
    orissa: 'Odisha',
    ka: 'Karnataka',
    tn: 'Tamil Nadu',
    ts: 'Telangana',
    tg: 'Telangana',
    ap: 'Andhra Pradesh',
    wb: 'West Bengal',
    uk: 'Uttarakhand',
    uttaranchal: 'Uttarakhand',
    jk: 'Jammu and Kashmir',
};
