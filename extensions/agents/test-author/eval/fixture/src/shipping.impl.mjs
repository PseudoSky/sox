export function shippingCost(order) {
  if (order.country !== 'US') throw new RangeError('unsupported country');
  for (const l of order.items) if (l.price < 0 || l.qty < 0) throw new RangeError('invalid line');
  if (order.items.length === 0) return 0;
  const subtotal = order.items.reduce((s, l) => s + l.price * l.qty, 0);
  if (subtotal >= 100) return 0;
  const units = order.items.reduce((s, l) => s + l.qty, 0);
  return 5 + (units > 3 ? (units - 3) * 2 : 0);
}
