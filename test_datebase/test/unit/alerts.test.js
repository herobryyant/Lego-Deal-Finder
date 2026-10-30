const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildSearchQuery,
  chooseCandidate,
  toCandidate,
} = require("../../scripts/check-price-alerts");

function ebayItem({
  id = "v1|123|0",
  price = 50,
  shipping = 5,
  currency = "USD",
} = {}) {
  return {
    itemId: id,
    title: `LEGO Set ${id}`,
    itemWebUrl:
      `https://www.ebay.com/itm/${id}`,

    price: {
      value: String(price),
      currency,
    },

    shippingOptions:
      shipping === undefined
        ? []
        : [
            {
              shippingCost: {
                value: String(shipping),
              },
            },
          ],
  };
}

test(
  "buildSearchQuery prefers a set number",
  () => {
    assert.equal(
      buildSearchQuery({
        set_number: "75192",
        search_query:
          "Millennium Falcon",
      }),
      "LEGO 75192"
    );
  }
);

test(
  "buildSearchQuery uses search terms without a set number",
  () => {
    assert.equal(
      buildSearchQuery({
        set_number: null,
        search_query:
          "Millennium Falcon",
      }),
      "LEGO Millennium Falcon"
    );
  }
);

test(
  "toCandidate includes shipping in total",
  () => {
    const candidate = toCandidate(
      ebayItem({
        price: 40,
        shipping: 7.5,
      })
    );

    assert.equal(
      candidate.totalPriceCents,
      4750
    );
  }
);

test(
  "toCandidate rejects unknown shipping",
  () => {
    assert.equal(
      toCandidate(
        ebayItem({
          price: 40,
          shipping: undefined,
        })
      ),
      null
    );
  }
);

test(
  "toCandidate rejects non-USD listings",
  () => {
    assert.equal(
      toCandidate(
        ebayItem({
          price: 40,
          shipping: 5,
          currency: "EUR",
        })
      ),
      null
    );
  }
);

test(
  "chooseCandidate selects the cheapest qualifying listing",
  () => {
    const candidate = chooseCandidate(
      [
        ebayItem({
          id: "expensive",
          price: 45,
          shipping: 5,
        }),

        ebayItem({
          id: "cheapest",
          price: 35,
          shipping: 4,
        }),
      ],
      5000
    );

    assert.equal(
      candidate.id,
      "cheapest"
    );

    assert.equal(
      candidate.totalPriceCents,
      3900
    );
  }
);

test(
  "chooseCandidate rejects listings above the target",
  () => {
    const candidate = chooseCandidate(
      [
        ebayItem({
          price: 50,
          shipping: 6,
        }),
      ],
      5500
    );

    assert.equal(candidate, null);
  }
);