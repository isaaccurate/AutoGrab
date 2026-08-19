const SLN_PATTERN = /^\d{5}$/;

export interface RegistrationTarget {
  readonly key: string;
  readonly slns: readonly string[];
}

function normalizedBundle(values: readonly string[]): readonly string[] {
  const slns = [...new Set(values.map((value) => value.trim()).filter(Boolean))]
    .sort();
  if (slns.length === 0 || !slns.every((sln) => SLN_PATTERN.test(sln))) {
    throw new Error("Every runtime target SLN must contain exactly five digits.");
  }
  return slns;
}

export function registrationTargetKey(slns: readonly string[]): string {
  return normalizedBundle(slns).join("+");
}

export function normalizeRegistrationTargets(
  values: readonly (readonly string[])[],
): readonly RegistrationTarget[] {
  if (values.length === 0) {
    throw new Error("At least one registration target is required.");
  }

  const seenKeys = new Set<string>();
  const targets: RegistrationTarget[] = [];
  for (const value of values) {
    const slns = normalizedBundle(value);
    const key = registrationTargetKey(slns);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    targets.push({ key, slns });
  }
  return targets;
}

export function singletonRegistrationTargets(
  slns: readonly string[],
): readonly RegistrationTarget[] {
  return normalizeRegistrationTargets(slns.map((sln) => [sln]));
}

export function flattenedTargetSlns(
  targets: readonly RegistrationTarget[],
): readonly string[] {
  return [...new Set(targets.flatMap((target) => target.slns))];
}

export function findRegistrationTarget(
  targets: readonly RegistrationTarget[],
  sln: string,
): RegistrationTarget | null {
  return targets.find((target) => target.slns.includes(sln)) ?? null;
}

export function hasRegistrationTarget(
  targets: readonly RegistrationTarget[],
  expected: Pick<RegistrationTarget, "key" | "slns">,
): boolean {
  return targets.some(
    (target) =>
      target.key === expected.key &&
      target.slns.length === expected.slns.length &&
      target.slns.every((sln, index) => sln === expected.slns[index]),
  );
}
