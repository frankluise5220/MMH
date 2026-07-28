const PATH_ALIASES = [
  { alias: "sidebar", target: "src/app/(sidebar)" },
];

function resolvePathAlias(value) {
  const text = String(value ?? "");
  const normalized = text.replace(/\\/g, "/");
  for (const { alias, target } of PATH_ALIASES) {
    if (normalized === alias) return target;
    if (normalized.startsWith(`${alias}/`)) return `${target}/${normalized.slice(alias.length + 1)}`;
  }
  return text;
}

function describePathAliases() {
  return PATH_ALIASES
    .map(({ alias, target }) => `  ${alias}[/...]  -> ${target}[/...]`)
    .join("\n");
}

module.exports = {
  describePathAliases,
  resolvePathAlias,
};
