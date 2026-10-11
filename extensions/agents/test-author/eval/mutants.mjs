// Seeded faults (a0897ba2 AC5): each mutant is one edit to shipping.impl.mjs.
export const MUTANTS = [
  { id: 'F1-free-boundary', from: 'subtotal >= 100', to: 'subtotal > 100' },
  { id: 'F2-extra-unit-threshold', from: 'units > 3', to: 'units > 4' },
  { id: 'F3-extra-unit-rate', from: '(units - 3) * 2', to: '(units - 3) * 3' },
  { id: 'F4-country-unchecked', from: "order.country !== 'US'", to: 'false' },
  { id: 'F5-negative-qty-accepted', from: 'l.price < 0 || l.qty < 0', to: 'l.price < 0' },
  { id: 'F6-empty-order-charged', from: 'if (order.items.length === 0) return 0;', to: '' },
  { id: 'F7-qty-ignored-in-subtotal', from: 's + l.price * l.qty', to: 's + l.price' },
];
