const test = require("node:test");
const assert = require("node:assert/strict");

const { median, toListing } = require("../../lib/deals");

test("median returns null for an empty array", () => {
  assert.equal(median([]), null);
});

test("median calculates an odd collection", () => {
  assert.equal(median([10, 2, 6]), 6);
});

test("median calculates an even collection", () => {
  assert.equal(median([10, 2, 6, 4]), 5);
});

test("median does not modify the original array", () => {
  const prices = [30, 10, 20];

  median(prices);

  assert.deepEqual(prices, [30, 10, 20]);
});

test("toListing includes shipping in the total", () => {
  const listing = toListing({
    itemId: "123",
    title: "LEGO Millennium Falcon",
    itemWebUrl: "https://www.ebay.com/itm/123",
    price: {
      value: "49.99",
      currency: "USD",
    },
    shippingOptions: [
      {
        shippingCost: {
          value: "5.00",
        },
      },
    ],
    condition: "New",
    seller: {
      username: "brick-seller",
    },
  });

  assert.equal(listing.price, 49.99);
  assert.equal(listing.shipping, 5);
  assert.equal(listing.total, 54.99);
  assert.equal(listing.shippingKnown, true);
  assert.equal(listing.seller, "brick-seller");
});

test("toListing handles missing shipping", () => {
  const listing = toListing({
    itemId: "456",
    title: "LEGO Castle",
    itemWebUrl: "https://www.ebay.com/itm/456",
    price: {
      value: "100",
      currency: "USD",
    },
  });

  assert.equal(listing.shipping, null);
  assert.equal(listing.shippingKnown, false);
  assert.equal(listing.total, 100);
});

test("toListing rejects listings without a valid price", () => {
  assert.equal(
    toListing({
      itemId: "789",
      title: "Invalid listing",
    }),
    null,
  );
});
