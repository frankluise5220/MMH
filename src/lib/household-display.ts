type HouseholdLike = {
  id?: string | null;
  name?: string | null;
};

/**
 * Does this string look like a machine-generated cuid rather than a ledger name
 * the user typed?
 *
 * Prisma's `@default(cuid())` produces `c` + 24+ lowercase base-36 characters.
 * The earlier `/^c[a-z0-9]{8,}$/i` matched anything starting with "c" and longer
 * than nine characters, so real ledger names such as "chenfamily2024" or
 * "cathy2024" were silently replaced by the fallback everywhere the name is
 * rendered. Anchor the shape instead of the prefix: no human types a 25-char
 * base-36 string that starts with `c`, and no cuid is shorter than that.
 */
function looksLikeInternalHouseholdId(value: string | null | undefined) {
  const trimmed = value?.trim();
  if (!trimmed) return false;
  return /^c[a-z0-9]{24,32}$/i.test(trimmed);
}

export function getHouseholdDisplayName(household: HouseholdLike | null | undefined, fallback = "默认账簿") {
  const id = household?.id?.trim() ?? "";
  const name = household?.name?.trim() ?? "";

  if (name && name !== id && !looksLikeInternalHouseholdId(name)) {
    return name;
  }

  return fallback;
}
