import rawCatalog from "../../../shared/settings/catalog.json";

export type SettingsSurface = "web" | "android";

export type SettingsCatalogItem = {
  id: string;
  label: string;
  description: string;
  icon: string;
  surfaces: SettingsSurface[];
  webHref?: string;
  androidRoute?: string;
  preferenceKeys?: string[];
  apiRefs?: string[];
};

export type SettingsCatalogGroup = {
  id: string;
  label: string;
  description: string;
  items: SettingsCatalogItem[];
};

export type SettingsCatalog = {
  schemaVersion: number;
  id: string;
  title: string;
  description: string;
  groups: SettingsCatalogGroup[];
};

export const settingsCatalog = rawCatalog as SettingsCatalog;

export function getSettingsCatalogForSurface(surface: SettingsSurface): SettingsCatalog {
  return {
    ...settingsCatalog,
    groups: settingsCatalog.groups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) => item.surfaces.includes(surface)),
      }))
      .filter((group) => group.items.length > 0),
  };
}

export function getSettingsItemsForSurface(surface: SettingsSurface) {
  return getSettingsCatalogForSurface(surface).groups.flatMap((group) => group.items);
}

export function findSettingsItem(id: string, surface?: SettingsSurface) {
  const groups = surface ? getSettingsCatalogForSurface(surface).groups : settingsCatalog.groups;
  for (const group of groups) {
    const item = group.items.find((entry) => entry.id === id);
    if (item) return item;
  }
  return null;
}
