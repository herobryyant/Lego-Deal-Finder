function median(values) {
  if (!values.length) return null;

  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);

  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function toListing(item) {
  const price = Number(item.price?.value);
  const rawShipping = item.shippingOptions?.[0]?.shippingCost?.value;
  const shipping = rawShipping == null ? null : Number(rawShipping);

  if (!Number.isFinite(price)) return null;

  const shippingKnown = Number.isFinite(shipping);

  return {
    id: item.itemId,
    title: item.title,
    url: item.itemWebUrl,
    image:
      item.image?.imageUrl ||
      item.thumbnailImages?.[0]?.imageUrl ||
      null,
    price,
    shipping: shippingKnown ? shipping : null,
    shippingKnown,
    total: price + (shippingKnown ? shipping : 0),
    currency: item.price?.currency || "USD",
    condition: item.condition || "Condition not specified",
    buyingOptions: item.buyingOptions || [],
    location:
      item.itemLocation?.city && item.itemLocation?.stateOrProvince
        ? `${item.itemLocation.city}, ${item.itemLocation.stateOrProvince}`
        : item.itemLocation?.country || "",
    seller: item.seller?.username || "",
  };
}

module.exports = {
  median,
  toListing,
};
