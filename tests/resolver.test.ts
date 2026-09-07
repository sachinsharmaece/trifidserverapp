import { describe, expect, it } from 'vitest';
import { resolveVisibility, type SellerBlockLookup } from '../src/modules/territory/resolver.js';

const noBlocks: SellerBlockLookup = () => false;
const sellerId = 'seller-1';
const otherSellerId = 'seller-2';

const myAreaTehsils = ['tehsil-a', 'tehsil-b'];
const allIndiaTehsils = ['tehsil-a', 'tehsil-b', 'tehsil-c', 'tehsil-d', 'tehsil-e'];
const allIndiaExceptMineTehsils = allIndiaTehsils.filter((id) => !myAreaTehsils.includes(id));
const customTehsils = ['tehsil-c', 'tehsil-e'];

function buyer(
  overrides: Partial<{ gstin: string; tehsilId: string; counterpartyId: string }> = {},
) {
  return {
    gstin: '23AAAAA0000A1Z5',
    tehsilId: 'tehsil-a',
    counterpartyId: 'buyer-1',
    ...overrides,
  };
}

/**
 * MASTER_PLAN.md §M3 — resolver truth table: the four scope-relevant cases
 * (my area, all-India, all-India-except-my-area, custom set) × blocked ×
 * not blocked × self-dealing (BR-084, BR-088, BR-092).
 */
describe('resolveVisibility (BR-088, WF-03)', () => {
  describe('my area scope', () => {
    it('is visible to a buyer inside the area', () => {
      const visible = resolveVisibility(
        { sellerId, frozenTehsilIds: myAreaTehsils },
        buyer({ tehsilId: 'tehsil-a' }),
        noBlocks,
      );
      expect(visible).toBe(true);
    });

    it('is not visible to a buyer outside the area', () => {
      const visible = resolveVisibility(
        { sellerId, frozenTehsilIds: myAreaTehsils },
        buyer({ tehsilId: 'tehsil-z' }),
        noBlocks,
      );
      expect(visible).toBe(false);
    });
  });

  describe('all-India scope', () => {
    it('is visible to a buyer anywhere in the frozen set', () => {
      const visible = resolveVisibility(
        { sellerId, frozenTehsilIds: allIndiaTehsils },
        buyer({ tehsilId: 'tehsil-e' }),
        noBlocks,
      );
      expect(visible).toBe(true);
    });
  });

  describe('all-India-except-my-area scope', () => {
    it("is not visible to a buyer inside the seller's own area", () => {
      const visible = resolveVisibility(
        { sellerId, frozenTehsilIds: allIndiaExceptMineTehsils },
        buyer({ tehsilId: 'tehsil-a' }),
        noBlocks,
      );
      expect(visible).toBe(false);
    });

    it("is visible to a buyer outside the seller's own area", () => {
      const visible = resolveVisibility(
        { sellerId, frozenTehsilIds: allIndiaExceptMineTehsils },
        buyer({ tehsilId: 'tehsil-c' }),
        noBlocks,
      );
      expect(visible).toBe(true);
    });
  });

  describe('custom tehsil set scope', () => {
    it('is visible only to buyers inside the exact custom set', () => {
      expect(
        resolveVisibility(
          { sellerId, frozenTehsilIds: customTehsils },
          buyer({ tehsilId: 'tehsil-c' }),
          noBlocks,
        ),
      ).toBe(true);
      expect(
        resolveVisibility(
          { sellerId, frozenTehsilIds: customTehsils },
          buyer({ tehsilId: 'tehsil-a' }),
          noBlocks,
        ),
      ).toBe(false);
    });
  });

  describe('blocks (BR-089)', () => {
    it('is not visible to a blocked GSTIN, even inside the area', () => {
      const isBlocked: SellerBlockLookup = (gstin) => gstin === '23AAAAA0000A1Z5';
      const visible = resolveVisibility(
        { sellerId, frozenTehsilIds: myAreaTehsils },
        buyer({ tehsilId: 'tehsil-a' }),
        isBlocked,
      );
      expect(visible).toBe(false);
    });

    it('does not affect a different GSTIN', () => {
      const isBlocked: SellerBlockLookup = (gstin) => gstin === '23AAAAA0000A1Z5';
      const visible = resolveVisibility(
        { sellerId, frozenTehsilIds: myAreaTehsils },
        buyer({ tehsilId: 'tehsil-a', gstin: '09BBBBB1111B2Z6' }),
        isBlocked,
      );
      expect(visible).toBe(true);
    });
  });

  describe('self-dealing (BR-092)', () => {
    it("never resolves as visible to the seller's own counterparty id", () => {
      const visible = resolveVisibility(
        { sellerId, frozenTehsilIds: allIndiaTehsils },
        buyer({ tehsilId: 'tehsil-a', counterpartyId: sellerId }),
        noBlocks,
      );
      expect(visible).toBe(false);
    });

    it('is unaffected when the buyer is a different counterparty than the seller', () => {
      const visible = resolveVisibility(
        { sellerId, frozenTehsilIds: allIndiaTehsils },
        buyer({ tehsilId: 'tehsil-a', counterpartyId: otherSellerId }),
        noBlocks,
      );
      expect(visible).toBe(true);
    });
  });
});
