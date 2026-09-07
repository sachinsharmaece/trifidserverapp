import { describe, expect, it } from 'vitest';
import { Manufacturer } from '../src/models/Manufacturer.js';
import { Product } from '../src/models/Product.js';
import { Sku } from '../src/models/Sku.js';
import { importSkus } from '../src/modules/catalog/catalog.service.js';

async function makeProduct() {
  const manufacturer = await Manufacturer.create({ name: `Mfr-${Date.now()}-${Math.random()}` });
  const product = await Product.create({
    brand: 'Test Brand',
    technical: 'Test Technical',
    manufacturerId: manufacturer._id,
    hsn: '38089199',
  });
  return product;
}

describe('SKU import (BR-055)', () => {
  it('imports a well-formed LTR row and computes baseUnitsPerBox', async () => {
    const product = await makeProduct();
    const results = await importSkus((product._id as unknown as string).toString(), [
      { packLabel: '1L', packSize: 1, baseUnit: 'LTR', unitsPerBox: 12 },
    ]);
    expect(results[0]?.accepted).toBe(true);
    const sku = await Sku.findById(results[0]?.skuId);
    expect(sku?.baseUnitsPerBox).toBe(12);
  });

  it('imports a well-formed PC row using unitsPerBox alone', async () => {
    const product = await makeProduct();
    const results = await importSkus((product._id as unknown as string).toString(), [
      { packLabel: '10pc', packSize: 10, baseUnit: 'PC', unitsPerBox: 5 },
    ]);
    expect(results[0]?.accepted).toBe(true);
    const sku = await Sku.findById(results[0]?.skuId);
    expect(sku?.baseUnitsPerBox).toBe(5);
  });

  it('rejects a row with an invalid baseUnit, not importing it', async () => {
    const product = await makeProduct();
    const results = await importSkus((product._id as unknown as string).toString(), [
      { packLabel: 'bad', packSize: 1, baseUnit: 'GAL', unitsPerBox: 12 },
    ]);
    expect(results[0]?.accepted).toBe(false);
    expect(results[0]?.reason).toMatch(/baseUnit/);
  });

  it('rejects a row with a non-positive unitsPerBox', async () => {
    const product = await makeProduct();
    const results = await importSkus((product._id as unknown as string).toString(), [
      { packLabel: 'bad', packSize: 1, baseUnit: 'LTR', unitsPerBox: 0 },
    ]);
    expect(results[0]?.accepted).toBe(false);
    expect(results[0]?.reason).toMatch(/unitsPerBox/);
  });

  it('reports each row independently in a mixed batch', async () => {
    const product = await makeProduct();
    const results = await importSkus((product._id as unknown as string).toString(), [
      { packLabel: 'good-1', packSize: 1, baseUnit: 'LTR', unitsPerBox: 12 },
      { packLabel: 'bad-1', packSize: 1, baseUnit: 'GAL', unitsPerBox: 12 },
      { packLabel: 'good-2', packSize: 5, baseUnit: 'KG', unitsPerBox: 4 },
    ]);
    expect(results.map((r) => r.accepted)).toEqual([true, false, true]);
  });
});

describe('Sku.baseUnit immutability (BR-055)', () => {
  it('cannot be changed after creation, through any code path', async () => {
    const product = await makeProduct();
    const sku = await Sku.create({
      productId: product._id,
      packLabel: '1L',
      packSize: 1,
      baseUnit: 'LTR',
      unitsPerBox: 12,
    });

    sku.baseUnit = 'KG';
    await sku.save();

    const reloaded = await Sku.findById(sku._id);
    expect(reloaded?.baseUnit).toBe('LTR');
  });
});
