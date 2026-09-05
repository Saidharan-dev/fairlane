// Seed catalog for the demo merchant.
// The "flash-drop" item is the one we deliberately give scarce stock
// to, so the concurrency/allocation story has something to bite on.
module.exports = {
  'sku-001': { name: 'Limited Edition Sneakers (Flash Drop)', price: 2999, stock: 3 },
  'sku-002': { name: 'Wireless Earbuds', price: 1499, stock: 50 },
  'sku-003': { name: 'Running Socks (3-pack)', price: 299, stock: 200 },
};
