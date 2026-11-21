const kgPerPound = 0.45359237;
const metersPerUnit = { m: 1, km: 1000, mi: 1609.344, yd: 0.9144, ft: 0.3048 };

export function convertWeight(value, from, to) {
  if (from === to) return value;
  return from === 'lb' ? value * kgPerPound : value / kgPerPound;
}

export function convertDistance(value, from, to) {
  if (from === to) return value;
  return value * (metersPerUnit[from] / metersPerUnit[to]);
}
