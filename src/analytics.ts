export function setDifference(a: Set<string>, b: Set<string>) {
  const out: string[] = [];
  for (const value of a) if (!b.has(value)) out.push(value);
  return out.sort();
}

export function setIntersection(a: Set<string>, b: Set<string>) {
  const out: string[] = [];
  for (const value of a) if (b.has(value)) out.push(value);
  return out.sort();
}

export function ratio(numerator: number, denominator: number) {
  return denominator ? Number((numerator / denominator).toFixed(4)) : null;
}
