// src/store.js
// This module defines the catalog of items available for purchase.
// Each item is represented as an object with the following properties:
//   - name: Human‑readable name of the product.
//   - price: Cost of the product (in your chosen currency unit).
//   - description (optional): A short description shown to customers.

const storeItems = {
  // Basic fruit items
  apple: {
    name: "Apple",
    price: 0.5,
    description: "Crisp and juicy red apple, perfect for a snack.",
  },

  banana: {
    name: "Banana",
    price: 0.3,
    description: "Ripe banana, great source of potassium.",
  },

  // Tech accessories
  usbCable: {
    name: "USB-C Cable",
    price: 9.99,
    description: "Durable 1‑meter USB‑C charging cable.",
  },

  wirelessMouse: {
    name: "Wireless Mouse",
    price: 25.0,
    description: "Ergonomic Bluetooth mouse with adjustable DPI.",
  },

  // Miscellaneous
  coffeeMug: {
    name: "Coffee Mug",
    price: 12.5,
    // Description omitted to demonstrate the optional field.
  },
};

// Freeze the object to prevent accidental mutations at runtime.
Object.freeze(storeItems);
Object.freeze(storeItems.apple);
Object.freeze(storeItems.banana);
Object.freeze(storeItems.usbCable);
Object.freeze(storeItems.wirelessMouse);
Object.freeze(storeItems.coffeeMug);

// Export the catalog using CommonJS syntax.
module.exports = storeItems;