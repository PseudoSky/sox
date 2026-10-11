# ITEM-77 shippingCost(order)

order = { country: string, items: [{ price: number, qty: number }] }

- AC1 subtotal = sum of price * qty over items.
- AC2 subtotal >= 100 (exactly 100 included) ships free: result 0.
- AC3 otherwise shipping is a flat 5, plus 2 for every unit beyond the third (units = sum of qty; 4 units adds 2, 5 adds 4).
- AC4 only country "US" is supported; any other country throws RangeError.
- AC5 an order with no items costs 0.
- AC6 a line with negative price or negative qty throws RangeError.
- Order of checks: country (AC4), then line validity (AC6), then AC5, then pricing.
