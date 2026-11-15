export const appThemes = Object.freeze({
  normal: { name: "Normal", description: "BlockHost’s original dark blue.", titlebar: "#07111d", symbols: "#7890a8" },
  minecraft: { name: "Minecraft", description: "Pixel lettering, grass accents and stone panels.", titlebar: "#1c241a", symbols: "#c1d4b4" },
  amethyst: { name: "Amethyst", description: "Deep violet with soft lavender highlights.", titlebar: "#1d1529", symbols: "#d1bce9" },
  monarch: { name: "Monarch", description: "Deep plum and golden monarch butterfly wings.", titlebar: "#261b25", symbols: "#f9d69d" },
  ocean: { name: "Ocean", description: "Deep teal and a breaking wave.", titlebar: "#102729", symbols: "#a0e4db" },
  sakura: { name: "Sakura", description: "Dusky rose and soft cherry blossoms.", titlebar: "#30202b", symbols: "#f6bdcf" },
  ember: { name: "Ember", description: "Blackened red with a bright flame.", titlebar: "#2c1718", symbols: "#ffc0a1" },
  frost: { name: "Frost", description: "Glacier blue and an icy snowflake.", titlebar: "#172934", symbols: "#c4edff" },
  desert: { name: "Desert", description: "Warm sandstone and sunlit dunes.", titlebar: "#2c2118", symbols: "#f5d6a1" },
  midnight: { name: "Midnight", description: "Indigo night sky with a crescent moon.", titlebar: "#17192f", symbols: "#c1caff" },
});

function normalizeTheme(theme, fallback) {
  if (theme === "terminal") return "monarch";
  return typeof theme === "string" && Object.hasOwn(appThemes, theme) ? theme : fallback;
}

export function normalizeAppTheme(theme) {
  return normalizeTheme(theme, "minecraft");
}

export function normalizeServerIcon(icon) {
  return normalizeTheme(icon, "normal");
}
