import { parseCsv } from './csv';

describe('parseCsv', () => {
  test('parses a simple header + rows CSV', () => {
    const { headers, rows } = parseCsv('amount,merchant\n50,Starbucks\n120.50,Amazon');
    expect(headers).toEqual(['amount', 'merchant']);
    expect(rows).toEqual([
      { amount: '50', merchant: 'Starbucks' },
      { amount: '120.50', merchant: 'Amazon' },
    ]);
  });

  test('lower-cases headers so column order/case in the source file does not matter', () => {
    const { headers } = parseCsv('Amount,Merchant,Card_Type\n10,X,credit');
    expect(headers).toEqual(['amount', 'merchant', 'card_type']);
  });

  test('honors a quoted field containing a comma', () => {
    const { rows } = parseCsv('amount,merchant\n50,"Smith, Jones & Co"');
    expect(rows[0].merchant).toBe('Smith, Jones & Co');
  });

  test('unescapes a doubled quote inside a quoted field', () => {
    const { rows } = parseCsv('amount,merchant\n50,"Joe""s Diner"');
    expect(rows[0].merchant).toBe('Joe"s Diner');
  });

  test('skips blank lines', () => {
    const { rows } = parseCsv('amount,merchant\n50,X\n\n60,Y\n');
    expect(rows).toHaveLength(2);
  });

  test('trims whitespace around unquoted fields', () => {
    const { rows } = parseCsv('amount, merchant \n 50 , Starbucks ');
    expect(rows[0]).toEqual({ amount: '50', merchant: 'Starbucks' });
  });

  test('missing trailing columns in a short row become empty strings', () => {
    const { rows } = parseCsv('amount,merchant,category\n50,Starbucks');
    expect(rows[0]).toEqual({ amount: '50', merchant: 'Starbucks', category: '' });
  });

  test('empty input returns no headers and no rows', () => {
    expect(parseCsv('')).toEqual({ headers: [], rows: [] });
    expect(parseCsv('   \n  \n')).toEqual({ headers: [], rows: [] });
  });
});
